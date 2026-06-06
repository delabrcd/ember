// Open-Meteo Archive API: full-history DAILY temperatures for a lat/lon. The
// network call lives in the thin `fetchDailyTemps`; the daily→monthly rollup is
// a PURE, unit-tested function (`rollupDailyToMonthly` / `dailyToMonthlyMean`).

import type { LatLon } from './geocode';

// One day of temperatures, in degrees of `unit`.
export interface DailyTemp {
  date: string; // YYYY-MM-DD
  tMean: number;
  tMin: number | null;
  tMax: number | null;
}

// A month's rolled-up summary. `avgTemperature` is the mean of the daily means,
// matching the existing monthly Weather model's semantics.
export interface MonthlyTemp {
  ym: number; // YYYYMM, e.g. 202601
  monthYear: string; // YYYY-MM-DD (first of month)
  avgTemperature: number;
  tMin: number | null; // coldest daily-min in the month
  tMax: number | null; // warmest daily-max in the month
  days: number; // how many daily samples backed the mean
}

// Open-Meteo archive "daily" block (parallel arrays keyed by `time`).
interface ArchiveDaily {
  time?: string[];
  temperature_2m_mean?: (number | null)[];
  temperature_2m_min?: (number | null)[];
  temperature_2m_max?: (number | null)[];
}
interface ArchiveResponse {
  daily?: ArchiveDaily;
}

// Mean of the defined numbers in a list, or null if there are none. Pure.
function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

// Parse Open-Meteo's parallel-array daily block into per-day rows, dropping any
// day without a mean temperature. Pure.
export function parseArchiveDaily(resp: ArchiveResponse | null | undefined): DailyTemp[] {
  const d = resp?.daily;
  const times = d?.time ?? [];
  const means = d?.temperature_2m_mean ?? [];
  const mins = d?.temperature_2m_min ?? [];
  const maxs = d?.temperature_2m_max ?? [];
  const out: DailyTemp[] = [];
  for (let i = 0; i < times.length; i++) {
    const tMean = means[i];
    if (typeof tMean !== 'number') continue; // skip gaps with no mean
    out.push({
      date: times[i],
      tMean,
      tMin: typeof mins[i] === 'number' ? (mins[i] as number) : null,
      tMax: typeof maxs[i] === 'number' ? (maxs[i] as number) : null,
    });
  }
  return out;
}

// Roll daily temps up to one row per calendar month: avgTemperature is the mean
// of that month's daily means; tMin/tMax are the month's extremes. Sorted by ym.
// PURE — this is what the hand-calculated test exercises.
export function rollupDailyToMonthly(daily: DailyTemp[]): MonthlyTemp[] {
  const byMonth = new Map<
    number,
    { means: number[]; mins: number[]; maxs: number[]; monthYear: string }
  >();
  for (const day of daily) {
    const ym = Number(day.date.slice(0, 4)) * 100 + Number(day.date.slice(5, 7));
    let bucket = byMonth.get(ym);
    if (!bucket) {
      bucket = { means: [], mins: [], maxs: [], monthYear: `${day.date.slice(0, 7)}-01` };
      byMonth.set(ym, bucket);
    }
    bucket.means.push(day.tMean);
    if (day.tMin !== null) bucket.mins.push(day.tMin);
    if (day.tMax !== null) bucket.maxs.push(day.tMax);
  }

  const rows: MonthlyTemp[] = [];
  for (const [ym, b] of byMonth) {
    const avg = mean(b.means);
    if (avg === null) continue;
    rows.push({
      ym,
      monthYear: b.monthYear,
      avgTemperature: avg,
      tMin: b.mins.length ? Math.min(...b.mins) : null,
      tMax: b.maxs.length ? Math.max(...b.maxs) : null,
      days: b.means.length,
    });
  }
  rows.sort((a, b) => a.ym - b.ym);
  return rows;
}

// Convenience alias: the bare mean-of-daily-means a month would report. Pure.
export function dailyToMonthlyMean(daily: DailyTemp[]): number | null {
  return mean(daily.map((d) => d.tMean));
}

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

// Fetch daily temps for [start, end] (inclusive, YYYY-MM-DD) at a location.
// IMPURE (one HTTP GET). `unit` is "F" (default) or "C". Returns parsed daily rows.
export async function fetchDailyTemps(
  loc: LatLon,
  start: string,
  end: string,
  unit: 'F' | 'C' = 'F'
): Promise<DailyTemp[]> {
  const url = new URL(ARCHIVE_URL);
  url.searchParams.set('latitude', String(loc.latitude));
  url.searchParams.set('longitude', String(loc.longitude));
  url.searchParams.set('start_date', start);
  url.searchParams.set('end_date', end);
  url.searchParams.set('daily', 'temperature_2m_mean,temperature_2m_max,temperature_2m_min');
  url.searchParams.set('temperature_unit', unit === 'C' ? 'celsius' : 'fahrenheit');
  url.searchParams.set('timezone', 'auto');

  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`open-meteo archive failed: ${res.status} ${res.statusText}`);
  const json = (await res.json()) as ArchiveResponse;
  return parseArchiveDaily(json);
}
