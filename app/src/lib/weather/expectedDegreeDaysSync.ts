// IMPURE wrapper for the expected next-bill-window degree-days (issue #44):
// fetch the live forecast for the in-horizon portion of the window, read cached
// daily history for the climatological normals, and delegate the arithmetic to
// the PURE assembleExpectedDegreeDays(). Kept in its own module (separate from
// the pure math) so the math stays unit-testable without a DB/Prisma client.
//
// FAILURE-TOLERANT BY DESIGN: any forecast fetch error falls back to normals for
// the WHOLE window and NEVER throws into the estimate path. Returns null only
// when there is no usable weather at all (no coords AND no history).

import { prisma } from '@/lib/db';
import type { LatLon } from './geocode';
import { fetchForecastDailyTemps, FORECAST_HORIZON_DAYS, type DailyTemp } from './openMeteo';
import {
  assembleExpectedDegreeDays,
  dayOfYearNormals,
  daysInRange,
  overallMean,
} from './expectedDegreeDays';
import type { ExpectedDegreeDays } from '@/lib/prediction';
import { isoDate as ymd, ymAddMonths } from '@/lib/ym';

const DAY = 24 * 60 * 60 * 1000;

// First/last UTC day of a YYYYMM calendar month.
const ymMonthStart = (ym: number) => new Date(Date.UTC(Math.floor(ym / 100), (ym % 100) - 1, 1));
const ymMonthEnd = (ym: number) => new Date(Date.UTC(Math.floor(ym / 100), ym % 100, 0));

export async function expectedDegreeDaysForWindow(
  accountId: number,
  windowStart: Date,
  windowEnd: Date,
  baseF: number,
  loc: LatLon | null
): Promise<ExpectedDegreeDays | null> {
  const windowDays = daysInRange(windowStart, windowEnd);
  if (!windowDays.length) return null;

  // History for normals: the account's cached daily temps.
  const dailyRows = await prisma.weatherDaily.findMany({
    where: { accountId },
    select: { date: true, tMean: true },
    orderBy: { date: 'asc' },
  });
  const history = dailyRows.map((d) => ({ date: ymd(d.date), tMean: d.tMean }));
  const normals = dayOfYearNormals(history);
  const overall = overallMean(history);

  // Forecast only the portion of the window inside the API's horizon, starting
  // no earlier than today. One small GET; isolated and failure-tolerant.
  let forecast: DailyTemp[] = [];
  if (loc) {
    const today = new Date(Date.now());
    const fcStart = new Date(Math.max(today.getTime(), windowStart.getTime()));
    const horizonEnd = new Date(today.getTime() + FORECAST_HORIZON_DAYS * DAY);
    const fcEnd = new Date(Math.min(horizonEnd.getTime(), windowEnd.getTime()));
    if (fcStart.getTime() <= fcEnd.getTime()) {
      try {
        forecast = await fetchForecastDailyTemps(loc, ymd(fcStart), ymd(fcEnd), 'F');
      } catch {
        // Be a good guest and resilient: fall back to normals for the whole
        // window. The estimate path must never throw on a weather hiccup.
        forecast = [];
      }
    }
  }

  // With neither a forecast nor any history there is nothing to estimate from.
  if (!forecast.length && !normals.size && overall == null) return null;

  return assembleExpectedDegreeDays(windowDays, forecast, normals, overall, baseF);
}

// IMPURE per-future-month NORMAL degree-days for the 12-month seasonal projection
// (issue #52). For each of the 12 calendar months after `latestYm` we sum the
// climatological-NORMAL HDD/CDD over that month's days, from the account's cached
// daily history (day-of-year normals). No forecast: a year out there is none, so
// every day is sourced from normals (or the overall mean as a last resort).
//
// FAILURE-TOLERANT BY DESIGN: never throws. A month we can't source any normal
// for (no history at all) is simply omitted from the map — projectSeason() then
// falls back to that month's same-month-last-year usage. Returns an empty map
// when there's no usable history, which makes the whole season fall back cleanly.
export async function seasonNormalsByMonth(
  accountId: number,
  latestYm: number,
  baseF: number
): Promise<Map<number, ExpectedDegreeDays>> {
  const out = new Map<number, ExpectedDegreeDays>();
  try {
    const dailyRows = await prisma.weatherDaily.findMany({
      where: { accountId },
      select: { date: true, tMean: true },
      orderBy: { date: 'asc' },
    });
    const history = dailyRows.map((d) => ({ date: ymd(d.date), tMean: d.tMean }));
    const normals = dayOfYearNormals(history);
    const overall = overallMean(history);
    if (!normals.size && overall == null) return out; // no usable history

    for (let h = 1; h <= 12; h++) {
      const ym = ymAddMonths(latestYm, h);
      const days = daysInRange(ymMonthStart(ym), ymMonthEnd(ym));
      // No forecast slice for a year-out month — assemble entirely from normals.
      const edd = assembleExpectedDegreeDays(days, [], normals, overall, baseF);
      // Only keep a month we could actually source normals for every (or any) day.
      if (edd.normalDays > 0) out.set(ym, edd);
    }
  } catch {
    // Be resilient: any read error -> empty map -> season falls back cleanly.
    return out;
  }
  return out;
}
