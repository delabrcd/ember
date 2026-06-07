// Read layer shared by API routes. The actual aggregation + rate math lives in
// the pure, unit-tested deriveMonthlySeries (series.ts); here we just fetch and
// hand it DB rows.
import { prisma } from '@/lib/db';
import type { MonthRow } from '@/lib/chartSpec';
import { deriveMonthlySeries, type DegreeDayInput } from '@/lib/series';
import { sumDegreeDays } from '@/lib/weather/degreeDays';
import { monthlyTempByYm } from '@/lib/weather/monthlyTemp';
import { getSetting } from '@/lib/settings';
import { estimateNextBill } from '@/lib/prediction';
import { shapeAccount, type AccountSummary } from '@/lib/accountSwitcher';
import { ymFromDate as ymOf, isoDate as ymd } from '@/lib/ym';
import type { Bill } from '@prisma/client';

// First/last day of the calendar month a statement falls in (UTC), used as the
// degree-day window fallback when a bill is missing periodFrom/periodTo.
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));

export type { MonthRow };

// Single home for the API-facing Bill shape: the period energy charge rule and
// ISO-date conversion, deduplicated across getBills / getOverview.
function shapeBill(b: Bill) {
  return {
    statementDate: ymd(b.statementDate),
    periodFrom: b.periodFrom ? ymd(b.periodFrom) : null,
    periodTo: b.periodTo ? ymd(b.periodTo) : null,
    totalDueAmount: b.currentCharges ?? b.totalDueAmount, // period energy charges
    amountDue: b.totalDueAmount, // statement amount due (with any carryover)
    hasPdf: !!b.pdfPath,
  };
}

export async function getDefaultAccount() {
  return prisma.account.findFirst({ orderBy: { id: 'asc' } });
}

// True when the given id maps to a real account. Used by the read routes to
// validate an incoming ?accountId= before scoping a query to it.
export async function accountExists(accountId: number): Promise<boolean> {
  const a = await prisma.account.findUnique({ where: { id: accountId }, select: { id: true } });
  return a !== null;
}

// All accounts (id-ordered, same as the default) with their login joined so the
// switcher can group + label them. The flat, client-safe shaping is the pure
// shapeAccount (accountSwitcher.ts) — it never leaks a credential.
export async function listAccounts(): Promise<AccountSummary[]> {
  const accounts = await prisma.account.findMany({
    orderBy: { id: 'asc' },
    select: {
      id: true,
      accountNumber: true,
      serviceAddress: true,
      region: true,
      loginId: true,
      login: { select: { id: true, label: true } },
    },
  });
  return accounts.map(shapeAccount);
}

// Resolve the account a read route should scope to. With no ?accountId= we keep
// the historical behaviour (the default account). A well-formed id that exists
// is used as-is; a malformed or non-existent id is a client error (caller
// returns 400). Returns the account or, on a bad explicit id, `'invalid'`.
export async function resolveRequestAccount(
  url: string
): Promise<{ id: number } | null | 'invalid'> {
  const raw = new URL(url).searchParams.get('accountId');
  if (raw == null || raw === '') return getDefaultAccount();
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return 'invalid';
  return (await accountExists(id)) ? { id } : 'invalid';
}

export async function getMonthlySeries(accountId: number): Promise<MonthRow[]> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  const [usages, costs, weather, bills, daily, baseSetting] = await Promise.all([
    prisma.usage.findMany({ where: { accountId } }),
    prisma.cost.findMany({ where: { accountId } }),
    account?.region ? prisma.weather.findMany({ where: { region: account.region } }) : Promise.resolve([]),
    prisma.bill.findMany({ where: { accountId } }),
    prisma.weatherDaily.findMany({ where: { accountId }, orderBy: { date: 'asc' } }),
    getSetting('degreeDayBaseF'),
  ]);

  // One temp per month, resolved by monthlyTempByYm (pure): prefer the
  // full-history Open-Meteo monthly rollup, then the account's own daily temps
  // rolled up (covers a null/mismatched `region`, where the region-keyed monthly
  // read returns nothing), then NG's ~24-month fallback. This guarantees weather
  // surfaces from the account's own data even when `region` is null.
  const dailyTemps = daily.map((d) => ({
    date: ymd(d.date),
    tMean: d.tMean,
    tMin: d.tMin,
    tMax: d.tMax,
  }));
  const tempByYm = monthlyTempByYm(
    weather.map((w) => ({ ym: ymOf(w.monthYear), avgTemperature: w.avgTemperature, source: w.source })),
    dailyTemps
  );

  // Degree-days per bill PERIOD. Read the configurable balance point (default 65°F)
  // and, for each bill, sum HDD/CDD over [periodFrom, periodTo] — falling back to
  // the statement's calendar month when a period bound is missing — from the daily
  // temps. Keyed to ymOf(statementDate) so it lines up with the rest of the series.
  const baseF = Number.parseFloat(baseSetting ?? '');
  const base = Number.isFinite(baseF) ? baseF : 65;
  const dailyRows = dailyTemps; // { date, tMean } — sumDegreeDays only reads those
  const degreeDays: DegreeDayInput[] = bills.map((b) => {
    const from = b.periodFrom ?? monthStart(b.statementDate);
    const to = b.periodTo ?? monthEnd(b.statementDate);
    const lo = ymd(from);
    const hi = ymd(to);
    const window = dailyRows.filter((d) => d.date >= lo && d.date <= hi);
    const { hdd, cdd } = sumDegreeDays(window, base);
    return { ym: ymOf(b.statementDate), hdd, cdd };
  });

  return deriveMonthlySeries({
    usages: usages.map((u) => ({ periodYearMonth: u.periodYearMonth, usageType: u.usageType, quantity: u.quantity })),
    costs: costs.map((c) => ({ periodYearMonth: c.periodYearMonth, fuelType: c.fuelType, kind: c.kind, amount: c.amount })),
    weather: [...tempByYm].map(([ym, avgTemperature]) => ({ ym, avgTemperature })),
    // Use the bill PDF's current charges (this period's energy cost) for analysis,
    // falling back to the API amount due only if a PDF wasn't parsed.
    bills: bills.map((b) => ({ ym: ymOf(b.statementDate), totalDueAmount: b.currentCharges ?? b.totalDueAmount })),
    degreeDays,
  });
}

export async function getBills(accountId: number) {
  const bills = await prisma.bill.findMany({
    where: { accountId },
    orderBy: { statementDate: 'desc' },
  });
  return bills.map(shapeBill);
}

export async function getOverview(accountId: number) {
  const [account, bills, schedule, lastRun, series] = await Promise.all([
    prisma.account.findUnique({ where: { id: accountId } }),
    prisma.bill.findMany({ where: { accountId }, orderBy: { statementDate: 'desc' } }),
    prisma.scheduleState.findUnique({ where: { accountId } }),
    prisma.scrapeRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    getMonthlySeries(accountId),
  ]);
  // Lifetime energy spend = sum of each period's actual charges (not statement
  // amounts due, which would double-count any carried-over balances).
  const lifetimeSpend = bills.reduce((s, b) => s + (shapeBill(b).totalDueAmount ?? 0), 0);
  // Estimated cost of the next bill from recent usage + current rates (pure,
  // PDF-sourced; an estimate, never stored and never fed to /api/verify).
  const nextBillEstimate = estimateNextBill(series);
  const latest = bills[0] ? shapeBill(bills[0]) : null;
  return {
    account: account
      ? {
          accountNumber: account.accountNumber,
          serviceAddress: account.serviceAddress,
          region: account.region,
          companyCode: account.companyCode,
          fuelTypes: account.fuelTypes,
        }
      : null,
    billCount: bills.length,
    lifetimeSpend,
    nextBillEstimate,
    latestBill: latest
      ? {
          statementDate: latest.statementDate,
          totalDueAmount: latest.totalDueAmount,
          periodFrom: latest.periodFrom,
          periodTo: latest.periodTo,
        }
      : null,
    firstStatement: bills.length ? ymd(bills[bills.length - 1].statementDate) : null,
    schedule: schedule
      ? {
          predictedNextBillDate: schedule.predictedNextBillDate ? ymd(schedule.predictedNextBillDate) : null,
          nextCheckAt: schedule.nextCheckAt?.toISOString() ?? null,
          lastCheckedAt: schedule.lastCheckedAt?.toISOString() ?? null,
        }
      : null,
    lastRun: lastRun
      ? {
          id: lastRun.id,
          status: lastRun.status,
          trigger: lastRun.trigger,
          startedAt: lastRun.startedAt.toISOString(),
          finishedAt: lastRun.finishedAt?.toISOString() ?? null,
          message: lastRun.message,
        }
      : null,
  };
}
