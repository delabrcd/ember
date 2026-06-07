// Expected HEATING/COOLING degree-days for the predicted next-bill window
// (issue #44) — the PURE assembly math. The degree-day usage regression in
// prediction.ts needs to know *how cold/hot* the coming bill period will be;
// this module combines a forecast slice with climatological NORMALS (the mean
// temperature for each day-of-year across cached history) and sums to HDD/CDD.
//
// PURE — no DB, no network, no React — so it's unit-tested directly. The impure
// wrapper that fetches the forecast and reads cached history lives in
// expectedDegreeDaysSync.ts and delegates the arithmetic here.

import type { DailyTemp } from './openMeteo';
import { sumDegreeDays } from './degreeDays';
import type { ExpectedDegreeDays } from '@/lib/prediction';
import { isoDate as ymd } from '@/lib/ym';

const DAY = 24 * 60 * 60 * 1000;

// The inclusive list of YYYY-MM-DD dates in [start, end] (UTC). Empty when the
// range is inverted. PURE.
export function daysInRange(start: Date, end: Date): string[] {
  const out: string[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += DAY) {
    out.push(ymd(new Date(t)));
  }
  return out;
}

// Month-day key "MM-DD" of a YYYY-MM-DD date. Used to bucket history by day-of-
// year so a given calendar day's normal is the mean across all years we have.
const monthDay = (iso: string): string => iso.slice(5, 10);

// Climatological normal temperatures, keyed by "MM-DD": the mean of every cached
// daily mean that falls on that calendar day across all history. PURE.
export function dayOfYearNormals(history: { date: string; tMean: number }[]): Map<string, number> {
  const buckets = new Map<string, { sum: number; n: number }>();
  for (const d of history) {
    const k = monthDay(d.date);
    const b = buckets.get(k) ?? { sum: 0, n: 0 };
    b.sum += d.tMean;
    b.n += 1;
    buckets.set(k, b);
  }
  const out = new Map<string, number>();
  for (const [k, b] of buckets) out.set(k, b.sum / b.n);
  return out;
}

// Overall mean of the cached history — the last-resort normal for a calendar day
// we have no same-day history for (e.g. Feb 29). Null when history is empty. PURE.
export function overallMean(history: { date: string; tMean: number }[]): number | null {
  if (!history.length) return null;
  return history.reduce((s, d) => s + d.tMean, 0) / history.length;
}

// Assemble the window's daily mean temps from a forecast slice + normals, then
// sum to HDD/CDD. For each day in `windowDays`: use the forecast's tMean if that
// exact date is present, else the day-of-year normal, else the overall mean.
// A day with no forecast and no history at all is dropped (can't be estimated).
// PURE — this is the unit-tested core; the impure wrapper only fetches/reads.
export function assembleExpectedDegreeDays(
  windowDays: string[],
  forecast: DailyTemp[],
  normals: Map<string, number>,
  overall: number | null,
  baseF: number
): ExpectedDegreeDays {
  const fc = new Map(forecast.map((d) => [d.date, d.tMean]));
  const daily: { date: string; tMean: number }[] = [];
  let forecastDays = 0;
  let normalDays = 0;
  for (const date of windowDays) {
    if (fc.has(date)) {
      daily.push({ date, tMean: fc.get(date) as number });
      forecastDays += 1;
      continue;
    }
    const norm = normals.get(monthDay(date)) ?? overall;
    if (norm == null) continue; // no forecast, no history for this day -> skip
    daily.push({ date, tMean: norm });
    normalDays += 1;
  }
  const { hdd, cdd } = sumDegreeDays(daily, baseF);
  return { hdd, cdd, forecastDays, normalDays };
}
