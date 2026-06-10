// Idempotent upsert of a CollectResult into Postgres.
import { prisma } from '@/lib/db';
import { detectSanityFloor, type SanityFlag, type SanityStream } from './sanityFloor';
import type { CollectResult } from './types';

const asDate = (s?: string): Date | null => (s ? new Date(s + 'T00:00:00Z') : null);

export interface PersistSummary {
  accountId: number;
  billsTotal: number;
  billsAdded: number;
  intervalsAdded: number;
  // Streams that an ESTABLISHED account returned zero rows for this scrape — an
  // upstream-shape break suspected (issue #135). Empty/undefined in the healthy
  // case. The handler surfaces these (ScrapeRun summary + Notification); persist
  // SKIPS the empty upsert loop for each so existing rows are preserved.
  sanityFlags?: SanityFlag[];
}

export interface PersistOptions {
  // Run the scrape sanity floor (issue #135). OFF by default. ONLY the full-scrape
  // path opts in, because only it persists a result where all three of bills/usage/
  // costs were genuinely fetched. The partial-persist callers (intervalPull,
  // pdfFetch) pass empty streams to mean "I didn't fetch this — leave it untouched",
  // NOT "upstream returned nothing"; running the floor there would flag every empty
  // stream as a suspect zero on every tick (and waste the extra COUNT queries). So
  // the detector is opt-in and only honest when the caller fetched all three.
  detectSanityFloor?: boolean;
}

export async function persist(
  result: CollectResult,
  opts: PersistOptions = {}
): Promise<PersistSummary> {
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

  // Scrape sanity floor (issue #135) — OPT-IN, only the full-scrape path enables it
  // (see PersistOptions). When OFF (a partial persist: intervalPull/pdfFetch pass
  // empty streams meaning "not fetched", NOT "upstream broke") we skip the detector
  // AND its extra COUNT queries entirely, leaving `suspect` empty so the upsert loops
  // below run exactly as they did before this feature. When ON, we count the prior
  // usage/cost rows too (bills use `before`), then ask the PURE detector which
  // streams an ESTABLISHED account returned zero rows for — a suspected upstream-
  // shape break. For each flagged stream we SKIP its upsert loop below so the empty
  // scrape can't write over good history, and we return the flag so the handler
  // surfaces it (no longer silent). A genuinely new/empty account (prior 0) never
  // trips this.
  let sanityFlags: SanityFlag[] = [];
  const suspect = new Set<SanityStream>();
  if (opts.detectSanityFloor) {
    const usageBefore = await prisma.usage.count({ where: { accountId: account.id } });
    const costBefore = await prisma.cost.count({ where: { accountId: account.id } });
    sanityFlags = detectSanityFloor({
      bills: { prior: before, incoming: result.bills.length },
      usages: { prior: usageBefore, incoming: result.usage.length },
      costs: { prior: costBefore, incoming: result.costs.length },
    });
    for (const f of sanityFlags) suspect.add(f.stream);
  }

  if (!suspect.has('bills')) for (const b of result.bills) {
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

  if (!suspect.has('usages')) for (const u of result.usage) {
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

  if (!suspect.has('costs')) for (const c of result.costs) {
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
  return {
    accountId: account.id,
    billsTotal: after,
    billsAdded: after - before,
    intervalsAdded,
    ...(sanityFlags.length ? { sanityFlags } : {}),
  };
}
