// Idempotent upsert of a CollectResult into Postgres.
import { prisma } from '@/lib/db';
import type { CollectResult } from './types';

const asDate = (s?: string): Date | null => (s ? new Date(s + 'T00:00:00Z') : null);

export interface PersistSummary {
  accountId: number;
  billsTotal: number;
  billsAdded: number;
  intervalsAdded: number;
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

  // Smart-meter AMI interval reads (issue #76). The windowed tail OVERLAPS what we
  // already have on purpose: AMI meters lag ~1–2 days and first report the freshest
  // hours as 0, then fill in the real value, so a re-scrape must be able to CORRECT
  // those hours. But we must NOT trust the API blindly: if it ever changes, glitches,
  // or returns 0/garbage for an hour we already have a GOOD reading for, an
  // unconditional upsert would clobber real history. So this is a CONDITIONAL,
  // FILL-ONLY upsert: insert new rows, and on conflict only overwrite when the stored
  // value is a provisional 0 AND the incoming value is real (non-zero). An
  // established non-zero reading is effectively write-once — never overwritten — so
  // historical data is immune to an upstream change. (A genuine idle 0 hour simply
  // stays 0.) Raw ON CONFLICT … WHERE because Prisma's upsert can't gate the UPDATE
  // on the existing row. Column/table names are the unmapped Prisma field names.
  // PURELY additive — never touches the monthly Usage/Cost logic or /api/verify.
  let intervalsAdded = 0;
  if (result.intervals.length) {
    const CHUNK = 500;
    for (let i = 0; i < result.intervals.length; i += CHUNK) {
      const chunk = result.intervals.slice(i, i + CHUNK);
      const counts = await prisma.$transaction(
        chunk.map(
          (iv) => prisma.$executeRaw`
            INSERT INTO "IntervalUsage"
              ("accountId","fuelType","intervalStart","intervalSeconds","quantity","unit","source")
            VALUES (${account.id}, ${iv.fuelType}, ${iv.intervalStart}, ${iv.intervalSeconds},
                    ${iv.quantity}, ${iv.unit}, ${iv.source})
            ON CONFLICT ("accountId","fuelType","intervalStart","intervalSeconds")
            DO UPDATE SET "quantity" = EXCLUDED."quantity",
                          "unit" = EXCLUDED."unit",
                          "source" = EXCLUDED."source"
            WHERE "IntervalUsage"."quantity" = 0 AND EXCLUDED."quantity" <> 0
          `
        )
      );
      intervalsAdded += counts.reduce((a, b) => a + b, 0); // rows inserted or filled
    }
  }

  const after = await prisma.bill.count({ where: { accountId: account.id } });
  return { accountId: account.id, billsTotal: after, billsAdded: after - before, intervalsAdded };
}
