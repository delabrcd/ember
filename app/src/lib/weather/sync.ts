// Historical-weather sync: geocode the account (once, cached), determine the
// full bill date range, and pull Open-Meteo DAILY temps for any months we don't
// already have. Persists daily rows (WeatherDaily) + a monthly rollup
// (Weather source="open-meteo"). Good-guest: only fetches missing date ranges.
//
// Network/DB live here; the parse/rollup math is the pure code in
// geocode.ts / openMeteo.ts. Called from the scrape after NG persist.

import { prisma } from '@/lib/db';
import { geocode, type LatLon } from './geocode';
import { fetchDailyTemps, rollupDailyToMonthly, type DailyTemp } from './openMeteo';
import { isoDate as ymd } from '@/lib/ym';

const UNIT = 'F' as const;
const SOURCE = 'open-meteo';

const toDate = (s: string): Date => new Date(s + 'T00:00:00Z');

export interface SyncResult {
  geocoded: boolean;
  dailyUpserted: number;
  monthsUpserted: number;
  skipped?: string; // reason we did nothing (no coords / no bills / already current)
}

// Ensure the account has cached lat/lon; geocode + persist if missing. Returns
// the coords or null when the address can't be resolved.
async function ensureLatLon(account: {
  id: number;
  serviceAddress: string | null;
  latitude: number | null;
  longitude: number | null;
}): Promise<{ loc: LatLon | null; geocoded: boolean }> {
  if (account.latitude !== null && account.longitude !== null) {
    return { loc: { latitude: account.latitude, longitude: account.longitude }, geocoded: false };
  }
  const loc = await geocode(account.serviceAddress);
  if (!loc) return { loc: null, geocoded: false };
  await prisma.account.update({
    where: { id: account.id },
    data: { latitude: loc.latitude, longitude: loc.longitude },
  });
  return { loc, geocoded: true };
}

// Persist daily rows + a monthly rollup for one contiguous fetched range.
async function persistRange(
  accountId: number,
  region: string | null,
  daily: DailyTemp[]
): Promise<{ dailyUpserted: number; monthsUpserted: number }> {
  let dailyUpserted = 0;
  for (const d of daily) {
    await prisma.weatherDaily.upsert({
      where: { accountId_date_source: { accountId, date: toDate(d.date), source: SOURCE } },
      create: { accountId, date: toDate(d.date), tMean: d.tMean, tMin: d.tMin, tMax: d.tMax, unit: UNIT, source: SOURCE },
      update: { tMean: d.tMean, tMin: d.tMin, tMax: d.tMax, unit: UNIT },
    });
    dailyUpserted++;
  }

  // Monthly Weather is region-keyed (shared model); only populate it when we know
  // the region. Daily rows above are always stored (degree-days need them).
  let monthsUpserted = 0;
  if (region) {
    for (const m of rollupDailyToMonthly(daily)) {
      await prisma.weather.upsert({
        where: { region_monthYear_source: { region, monthYear: toDate(m.monthYear), source: SOURCE } },
        create: { region, monthYear: toDate(m.monthYear), avgTemperature: m.avgTemperature, unit: UNIT, source: SOURCE },
        update: { avgTemperature: m.avgTemperature, unit: UNIT },
      });
      monthsUpserted++;
    }
  }
  return { dailyUpserted, monthsUpserted };
}

// Sync historical weather for an account. Safe to call every scrape: it geocodes
// at most once and only fetches date ranges not already stored as WeatherDaily.
export async function syncHistoricalWeather(accountId: number): Promise<SyncResult> {
  const account = await prisma.account.findUnique({ where: { id: accountId } });
  if (!account) return { geocoded: false, dailyUpserted: 0, monthsUpserted: 0, skipped: 'no account' };

  const { loc, geocoded } = await ensureLatLon(account);
  if (!loc) return { geocoded, dailyUpserted: 0, monthsUpserted: 0, skipped: 'no coords' };

  // Full bill history → desired [start, end]. Prefer period bounds, fall back to
  // statement dates. End is capped at yesterday (archive lags ~5 days but the API
  // tolerates a recent end; we use yesterday to avoid requesting future days).
  const bills = await prisma.bill.findMany({
    where: { accountId },
    select: { statementDate: true, periodFrom: true, periodTo: true },
  });
  if (bills.length === 0) return { geocoded, dailyUpserted: 0, monthsUpserted: 0, skipped: 'no bills' };

  const lows = bills.map((b) => b.periodFrom ?? b.statementDate);
  const highs = bills.map((b) => b.periodTo ?? b.statementDate);
  const wantStart = new Date(Math.min(...lows.map((d) => d.getTime())));
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const wantEndMs = Math.min(Math.max(...highs.map((d) => d.getTime())), yesterday.getTime());
  const wantEnd = new Date(wantEndMs);
  if (wantStart.getTime() > wantEnd.getTime()) {
    return { geocoded, dailyUpserted: 0, monthsUpserted: 0, skipped: 'empty range' };
  }

  // Good-guest: don't re-fetch days we already have. Narrow [wantStart, wantEnd]
  // to the two open ends around what's already stored (a single fetch each).
  const existing = await prisma.weatherDaily.aggregate({
    where: { accountId, source: SOURCE },
    _min: { date: true },
    _max: { date: true },
  });

  const ranges: Array<[Date, Date]> = [];
  if (!existing._min.date || !existing._max.date) {
    ranges.push([wantStart, wantEnd]);
  } else {
    const day = 24 * 60 * 60 * 1000;
    // Older gap: [wantStart, min-1]
    if (wantStart.getTime() < existing._min.date.getTime()) {
      ranges.push([wantStart, new Date(existing._min.date.getTime() - day)]);
    }
    // Newer gap: [max+1, wantEnd]
    if (wantEnd.getTime() > existing._max.date.getTime()) {
      ranges.push([new Date(existing._max.date.getTime() + day), wantEnd]);
    }
  }

  if (ranges.length === 0) {
    return { geocoded, dailyUpserted: 0, monthsUpserted: 0, skipped: 'already current' };
  }

  let dailyUpserted = 0;
  let monthsUpserted = 0;
  for (const [start, end] of ranges) {
    if (start.getTime() > end.getTime()) continue;
    const daily = await fetchDailyTemps(loc, ymd(start), ymd(end), UNIT);
    const r = await persistRange(accountId, account.region, daily);
    dailyUpserted += r.dailyUpserted;
    monthsUpserted += r.monthsUpserted;
  }

  return { geocoded, dailyUpserted, monthsUpserted };
}
