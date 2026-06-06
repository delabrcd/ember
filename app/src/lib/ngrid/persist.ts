// Idempotent upsert of a CollectResult into Postgres.
import { prisma } from '@/lib/db';
import type { CollectResult } from './types';

const asDate = (s?: string): Date | null => (s ? new Date(s + 'T00:00:00Z') : null);

export interface PersistSummary {
  accountId: number;
  billsTotal: number;
  billsAdded: number;
}

export async function persist(result: CollectResult): Promise<PersistSummary> {
  const a = result.account;

  // Tag the account with the login it was scraped under. Env-bootstrapped
  // scrapes pass no loginId, so we leave it null (and don't clobber an existing
  // value on update). When a login IS supplied we set/refresh it so re-running
  // under a stored NgLogin claims accounts that were first seen via env creds.
  const loginId = result.loginId;

  const account = await prisma.account.upsert({
    where: { accountNumber: a.accountNumber },
    create: {
      accountNumber: a.accountNumber,
      loginId,
      accountLink: a.accountLink,
      region: a.region,
      companyCode: a.companyCode,
      serviceAddress: a.serviceAddress,
      fuelTypes: a.fuelTypes,
      premiseNumber: a.premiseNumber,
      customerNumber: a.customerNumber,
    },
    update: {
      ...(loginId !== undefined ? { loginId } : {}),
      accountLink: a.accountLink,
      region: a.region,
      companyCode: a.companyCode,
      serviceAddress: a.serviceAddress,
      fuelTypes: a.fuelTypes,
      premiseNumber: a.premiseNumber,
      customerNumber: a.customerNumber,
    },
  });

  // Count existing bills first so we can report how many are new this run.
  const before = await prisma.bill.count({ where: { accountId: account.id } });

  for (const b of result.bills) {
    const statementDate = asDate(b.statementDate)!;
    await prisma.bill.upsert({
      where: { accountId_statementDate: { accountId: account.id, statementDate } },
      create: {
        accountId: account.id,
        statementDate,
        periodFrom: asDate(b.periodFrom),
        periodTo: asDate(b.periodTo),
        totalDueAmount: b.totalDueAmount,
        currentCharges: b.currentCharges,
        status: b.status,
        pdfPath: b.pdfPath,
      },
      update: {
        periodFrom: asDate(b.periodFrom),
        periodTo: asDate(b.periodTo),
        totalDueAmount: b.totalDueAmount,
        currentCharges: b.currentCharges ?? undefined,
        status: b.status,
        pdfPath: b.pdfPath ?? undefined,
      },
    });
  }

  for (const u of result.usage) {
    if (!u.periodYearMonth) continue;
    await prisma.usage.upsert({
      where: {
        accountId_usageType_periodYearMonth: {
          accountId: account.id,
          usageType: u.usageType,
          periodYearMonth: u.periodYearMonth,
        },
      },
      create: {
        accountId: account.id,
        usageType: u.usageType,
        periodYearMonth: u.periodYearMonth,
        quantity: u.quantity,
        unit: u.unit,
        dateFrom: asDate(u.dateFrom),
        dateTo: asDate(u.dateTo),
      },
      update: { quantity: u.quantity, unit: u.unit, dateFrom: asDate(u.dateFrom), dateTo: asDate(u.dateTo) },
    });
  }

  for (const c of result.costs) {
    if (!c.periodYearMonth || !c.fuelType) continue;
    await prisma.cost.upsert({
      where: {
        accountId_fuelType_kind_periodYearMonth: {
          accountId: account.id,
          fuelType: c.fuelType,
          kind: c.kind,
          periodYearMonth: c.periodYearMonth,
        },
      },
      create: {
        accountId: account.id,
        fuelType: c.fuelType,
        kind: c.kind,
        periodYearMonth: c.periodYearMonth,
        amount: c.amount,
        dateFrom: asDate(c.dateFrom),
        dateTo: asDate(c.dateTo),
      },
      update: { amount: c.amount, dateFrom: asDate(c.dateFrom), dateTo: asDate(c.dateTo) },
    });
  }

  // NG's weather feed is the FALLBACK source ("ng"). The full-history Open-Meteo
  // rows are written separately (source="open-meteo") by syncHistoricalWeather,
  // so the two never collide on the (region, monthYear, source) key.
  for (const w of result.weather) {
    const monthYear = asDate(w.monthYear)!;
    await prisma.weather.upsert({
      where: { region_monthYear_source: { region: w.region, monthYear, source: 'ng' } },
      create: { region: w.region, monthYear, avgTemperature: w.avgTemperature, unit: w.unit, source: 'ng' },
      update: { avgTemperature: w.avgTemperature, unit: w.unit },
    });
  }

  const after = await prisma.bill.count({ where: { accountId: account.id } });
  return { accountId: account.id, billsTotal: after, billsAdded: after - before };
}
