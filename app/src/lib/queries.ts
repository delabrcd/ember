// Read layer shared by API routes. The actual aggregation + rate math lives in
// the pure, unit-tested deriveMonthlySeries (series.ts); here we just fetch and
// hand it DB rows.
import { prisma } from '@/lib/db';
import type { MonthRow } from '@/lib/chartSpec';
import { deriveMonthlySeries } from '@/lib/series';

const ymOf = (d: Date) => d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);

export type { MonthRow };

export async function getDefaultAccount() {
  return prisma.account.findFirst({ orderBy: { id: 'asc' } });
}

export async function getMonthlySeries(accountId: number): Promise<MonthRow[]> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  const [usages, costs, weather, bills] = await Promise.all([
    prisma.usage.findMany({ where: { accountId } }),
    prisma.cost.findMany({ where: { accountId } }),
    account?.region ? prisma.weather.findMany({ where: { region: account.region } }) : Promise.resolve([]),
    prisma.bill.findMany({ where: { accountId } }),
  ]);

  // One temp per month: prefer the full-history Open-Meteo rollup over NG's
  // ~24-month fallback so the Usage-vs-weather chart spans the whole history.
  const tempByYm = new Map<number, number>();
  for (const w of weather) {
    const ym = ymOf(w.monthYear);
    if (w.source === 'open-meteo' || !tempByYm.has(ym)) tempByYm.set(ym, w.avgTemperature);
  }

  return deriveMonthlySeries({
    usages: usages.map((u) => ({ periodYearMonth: u.periodYearMonth, usageType: u.usageType, quantity: u.quantity })),
    costs: costs.map((c) => ({ periodYearMonth: c.periodYearMonth, fuelType: c.fuelType, kind: c.kind, amount: c.amount })),
    weather: [...tempByYm].map(([ym, avgTemperature]) => ({ ym, avgTemperature })),
    // Use the bill PDF's current charges (this period's energy cost) for analysis,
    // falling back to the API amount due only if a PDF wasn't parsed.
    bills: bills.map((b) => ({ ym: ymOf(b.statementDate), totalDueAmount: b.currentCharges ?? b.totalDueAmount })),
  });
}

export async function getBills(accountId: number) {
  const bills = await prisma.bill.findMany({
    where: { accountId },
    orderBy: { statementDate: 'desc' },
  });
  return bills.map((b) => ({
    statementDate: b.statementDate.toISOString().slice(0, 10),
    periodFrom: b.periodFrom?.toISOString().slice(0, 10) ?? null,
    periodTo: b.periodTo?.toISOString().slice(0, 10) ?? null,
    totalDueAmount: b.currentCharges ?? b.totalDueAmount, // period energy charges
    amountDue: b.totalDueAmount, // statement amount due (with any carryover)
    hasPdf: !!b.pdfPath,
  }));
}

export async function getOverview(accountId: number) {
  const [account, bills, schedule, lastRun] = await Promise.all([
    prisma.account.findUnique({ where: { id: accountId } }),
    prisma.bill.findMany({ where: { accountId }, orderBy: { statementDate: 'desc' } }),
    prisma.scheduleState.findUnique({ where: { accountId } }),
    prisma.scrapeRun.findFirst({ orderBy: { startedAt: 'desc' } }),
  ]);
  // Lifetime energy spend = sum of each period's actual charges (not statement
  // amounts due, which would double-count any carried-over balances).
  const lifetimeSpend = bills.reduce((s, b) => s + (b.currentCharges ?? b.totalDueAmount ?? 0), 0);
  const latest = bills[0];
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
    latestBill: latest
      ? {
          statementDate: latest.statementDate.toISOString().slice(0, 10),
          totalDueAmount: latest.currentCharges ?? latest.totalDueAmount,
          periodFrom: latest.periodFrom?.toISOString().slice(0, 10) ?? null,
          periodTo: latest.periodTo?.toISOString().slice(0, 10) ?? null,
        }
      : null,
    firstStatement: bills.length ? bills[bills.length - 1].statementDate.toISOString().slice(0, 10) : null,
    schedule: schedule
      ? {
          predictedNextBillDate: schedule.predictedNextBillDate?.toISOString().slice(0, 10) ?? null,
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
