// Read layer shared by API routes. The actual aggregation + rate math lives in
// the pure, unit-tested deriveMonthlySeries (series.ts); here we just fetch and
// hand it DB rows.
import { prisma } from '@/lib/db';
import type { MonthRow } from '@/lib/chartSpec';
import { deriveMonthlySeries, type DegreeDayInput } from '@/lib/series';
import { estimateEmissions, resolveEmissionFactors, trailing12Emissions } from '@/lib/emissions';
import { sumDegreeDays } from '@/lib/weather/degreeDays';
import { monthlyTempByYm } from '@/lib/weather/monthlyTemp';
import { getSetting } from '@/lib/settings';
import {
  estimateNextBill,
  estimateNextBillSeasonal,
  projectSeason,
  type SeasonProjection,
} from '@/lib/prediction';
import {
  trailing12AllIn,
  latestVsYearAgo,
  withSupplyRateTrailing,
  projectBudget,
  calendarYearWindow,
  type YoyResult,
  type BudgetFuturePeriod,
} from '@/lib/series';
import { detectAnomalies } from '@/lib/anomaly';
import { ymAddMonths } from '@/lib/ym';
import { seasonNormalsByMonth, nextBillWindowDegreeDays } from '@/lib/weather/expectedDegreeDaysSync';
import { shapeAccount, type AccountSummary } from '@/lib/accountSwitcher';
import { ymFromDate as ymOf, isoDate as ymd } from '@/lib/ym';
import type { Bill } from '@prisma/client';

// First/last day of the calendar month a statement falls in (UTC), used as the
// degree-day window fallback when a bill is missing periodFrom/periodTo.
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const monthEnd = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));

// Inclusive bill-period length in days ((periodTo - periodFrom) + 1), or null
// when either bound is missing. Used to populate MonthRow.days for the #67 rate
// model's fixed-$/day term.
const DAY_MS = 24 * 60 * 60 * 1000;
function billDays(from: Date | null, to: Date | null): number | null {
  if (!from || !to) return null;
  return Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
}

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
  const [usages, costs, weather, bills, daily, baseSetting, gridFactorSetting] = await Promise.all([
    prisma.usage.findMany({ where: { accountId } }),
    prisma.cost.findMany({ where: { accountId } }),
    account?.region ? prisma.weather.findMany({ where: { region: account.region } }) : Promise.resolve([]),
    prisma.bill.findMany({ where: { accountId } }),
    prisma.weatherDaily.findMany({ where: { accountId }, orderBy: { date: 'asc' } }),
    getSetting('degreeDayBaseF'),
    getSetting('gridEmissionFactor'),
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

  const rows = deriveMonthlySeries({
    usages: usages.map((u) => ({ periodYearMonth: u.periodYearMonth, usageType: u.usageType, quantity: u.quantity })),
    costs: costs.map((c) => ({ periodYearMonth: c.periodYearMonth, fuelType: c.fuelType, kind: c.kind, amount: c.amount })),
    weather: [...tempByYm].map(([ym, avgTemperature]) => ({ ym, avgTemperature })),
    // Use the bill PDF's current charges (this period's energy cost) for analysis,
    // falling back to the API amount due only if a PDF wasn't parsed.
    bills: bills.map((b) => ({
      ym: ymOf(b.statementDate),
      totalDueAmount: b.currentCharges ?? b.totalDueAmount,
      // Bill period length in days (inclusive); null when a period bound is
      // missing. Feeds the per-component fixed-$/day rate model (issue #67).
      days: billDays(b.periodFrom, b.periodTo),
    })),
    degreeDays,
  });

  // Carbon-footprint estimate (issue #49). Annotate each row with location-based
  // CO2e (kg) per fuel + combined, after the cost/rate math so it can never feed a
  // cost number or /api/verify. The electricity grid factor comes from the
  // gridEmissionFactor AppSetting override if set, else the account region's eGRID
  // subregion default. PURE — see lib/emissions.ts.
  const factors = resolveEmissionFactors(account?.region, gridFactorSetting);
  // Supply-rate trend (issue #48): stamp the trailing-average supply $/unit so the
  // rates chart can show the dashed trend line. Pure, in place; after the cost/rate
  // math, never feeds /api/verify.
  return withSupplyRateTrailing(estimateEmissions(rows, factors));
}

// Recent smart-meter AMI interval reads (issue #76) for the interval chart. Thin
// DB read only: returns raw IntervalUsage rows ordered by intervalStart, filtered
// to a fuel and a trailing window. Any chart shaping/aggregation belongs in a
// PURE helper (next phase); this just hands back the rows. PURELY observational —
// never a billed-cost number, never fed to /api/verify.
export type IntervalSeriesRow = {
  fuelType: string;
  intervalStart: Date;
  intervalSeconds: number;
  quantity: number;
  unit: string;
  source: string;
};

export async function getIntervalSeries(
  accountId: number,
  opts: { fuelType?: string; sinceDays?: number; from?: Date; to?: Date; intervalSeconds?: number } = {}
): Promise<IntervalSeriesRow[]> {
  // A concrete [from, to] window wins over sinceDays (the global RangeControl
  // path); sinceDays remains the trailing-window fallback for any caller that
  // still uses it. Either way the column filter is the indexed `intervalStart`.
  let when: { gte?: Date; lte?: Date };
  if (opts.from || opts.to) {
    when = {};
    if (opts.from) when.gte = opts.from;
    if (opts.to) when.lte = opts.to;
  } else {
    const sinceDays = opts.sinceDays && opts.sinceDays > 0 ? opts.sinceDays : 30;
    when = { gte: new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000) };
  }
  const rows = await prisma.intervalUsage.findMany({
    where: {
      accountId,
      intervalStart: when,
      ...(opts.fuelType ? { fuelType: opts.fuelType } : {}),
      // Optional grain filter (the raw-15m history path): when set, the DB returns
      // only rows of that grain (e.g. intervalSeconds=900 for 15-min electric)
      // rather than fetching all grains to filter in JS. Omitted = all grains.
      ...(opts.intervalSeconds ? { intervalSeconds: opts.intervalSeconds } : {}),
    },
    orderBy: { intervalStart: 'asc' },
    select: {
      fuelType: true,
      intervalStart: true,
      intervalSeconds: true,
      quantity: true,
      unit: true,
      source: true,
    },
  });
  return rows;
}

export async function getBills(accountId: number) {
  const bills = await prisma.bill.findMany({
    where: { accountId },
    orderBy: { statementDate: 'desc' },
  });
  return bills.map(shapeBill);
}

// Seasonal 12-month projection (issue #52). Impure assembly only: build each
// future calendar month's NORMAL degree-days from cached daily history
// (failure-tolerant — never throws, empty map -> projectSeason falls back to
// same-month-last-year), then hand the pure projector the series, the normals
// lookup and the SAME PDF-sourced trailing-12 all-in rates the headline cards and
// #44 use (currentCharges basis, NOT the API amount due). Nothing is stored; this
// never feeds /api/verify. Returns null only when there's no usage to anchor on.
async function computeSeasonProjection(
  accountId: number,
  series: MonthRow[]
): Promise<SeasonProjection | null> {
  const lastUsage = [...series].reverse().find((r) => r.kwh != null || r.therms != null);
  if (!lastUsage) return null;

  const baseSetting = await getSetting('degreeDayBaseF');
  const parsed = Number.parseFloat(baseSetting ?? '');
  const baseF = Number.isFinite(parsed) ? parsed : 65;

  const normalsByMonth = await seasonNormalsByMonth(accountId, lastUsage.ym, baseF);
  // projectSeason prefers the #67 per-component Kalman fixed+variable rate model
  // (computed internally from the series) and falls back to these flat all-in
  // rates only for sparse-history / new accounts.
  return projectSeason(series, normalsByMonth, {
    elec: trailing12AllIn(series, 'elec'),
    gas: trailing12AllIn(series, 'gas'),
  });
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
  // Estimated cost of the next bill. Prefer the seasonal Kalman-filter model
  // (issue #67): weather-normal usage × per-component Kalman-filtered
  // fixed+variable rates, which roughly halves the calendar method's error on
  // the real account. It needs the predicted next-bill window's degree-days
  // (forecast + normals, assembled impurely here) and ~18 usable bills; when those
  // aren't available it falls back to the plain calendar estimate (issue #9). Both
  // are PDF-sourced (currentCharges) estimates, never stored, never fed to
  // /api/verify.
  const baseSetting = await getSetting('degreeDayBaseF');
  const parsedBase = Number.parseFloat(baseSetting ?? '');
  const baseF = Number.isFinite(parsedBase) ? parsedBase : 65;
  const nextWindow = await nextBillWindowDegreeDays(accountId, baseF);
  const nextBillEstimate =
    estimateNextBillSeasonal(series, nextWindow ?? undefined) ?? estimateNextBill(series);
  // Seasonal 12-month projection (issue #52): per-month projected cost + an annual
  // total, both with horizon-widening bands. Climatological PROJECTION (degree-day
  // normals × all-in rates), never a forecast; never stored.
  const seasonProjection = await computeSeasonProjection(accountId, series);
  // Trailing-12 carbon-footprint estimate (issue #49): per-fuel + combined kg CO2e
  // over the most recent 12 estimated months, plus friendly equivalences. PURE
  // (the series already carries per-row co2e). A location-based ESTIMATE only;
  // never a cost number, never fed to /api/verify.
  const emissions = trailing12Emissions(series);
  // Always-visible "vs last year (normalized)" top-strip card (issue #47): the
  // weather-normalized usage change for the LATEST usage month vs the same
  // calendar month one year earlier, per fuel. PURE (latestVsYearAgo → compareYoY);
  // rates are the currentCharges-sourced trailing-12 all-in for the normalized
  // figure. null when there's no prior-year month to match. Never a real cost
  // number, never fed to /api/verify. The full interactive period-compare tool
  // computes its own windows client-side from the loaded series.
  const latestYoy: YoyResult | null = latestVsYearAgo(series);
  // Usage/cost anomaly detection (issue #45). Flags when the latest period's
  // weather-normalized intensity (kwhPerDegreeDay/thermsPerHdd) or all-in $/unit
  // (elecRateAllIn/gasRateAllIn) deviates from its robust trailing baseline
  // (> k·MAD from the trailing median) — so a merely-cold month does NOT trip it
  // but a genuine efficiency regression or a supply-rate/ESCO jump does. PURE
  // (detectAnomalies); all inputs are currentCharges-derived, never the API
  // amount due, and this never feeds /api/verify. Surfaced as a subtle callout
  // that renders nothing when `flags` is empty.
  const anomalies = detectAnomalies(series);
  // Budget / annual-spend target with on-track projection (issue #46). The target
  // is a per-account runtime AppSetting; the window defaults to the CALENDAR YEAR
  // of the latest usage month (so "spent so far" and the projection are about the
  // same year the data is in, not a server-clock year that might be ahead of the
  // data). Spent is the sum of in-window billTotal (= currentCharges, PDF source
  // of truth — projectBudget asserts this); the remaining projection REUSES the
  // already-computed next-bill estimate and seasonal projection (we don't recompute
  // anything), selecting only the in-window future periods. Null when no target is
  // set. Never a real charge, never fed to /api/verify.
  const budget = await (async () => {
    const raw = (await getSetting('budgetTarget')) ?? '';
    const target = Number.parseFloat(raw);
    if (!Number.isFinite(target) || target <= 0) return null;
    const lastUsage = [...series].reverse().find((r) => r.kwh != null || r.therms != null);
    const anchorYm = lastUsage?.ym ?? null;
    if (anchorYm == null) return null;
    const window = calendarYearWindow(anchorYm);
    // Map the next-bill estimate (which covers the month after the latest usage
    // row) and the seasonal projection months onto the budget's future-period
    // shape (ym + point/low/high band).
    const nextBill: BudgetFuturePeriod | null = nextBillEstimate
      ? {
          ym: ymAddMonths(anchorYm, 1),
          point: nextBillEstimate.point,
          low: nextBillEstimate.low,
          high: nextBillEstimate.high,
        }
      : null;
    const seasonMonths: BudgetFuturePeriod[] = (seasonProjection?.months ?? []).map((m) => ({
      ym: m.ym,
      point: m.projCost,
      low: m.low,
      high: m.high,
    }));
    return projectBudget(series, target, window, { nextBill, seasonMonths });
  })();
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
    seasonProjection,
    emissions,
    latestYoy,
    budget,
    anomalies,
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
