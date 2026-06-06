// Resolve ONE average temperature per month from the various weather sources we
// store, with a robust precedence so the Usage-vs-weather chart spans the whole
// bill history even when the region-keyed monthly rows are missing.
//
// We keep three sources:
//   - Weather(source="open-meteo")  full-history monthly rollup, region-keyed (primary)
//   - Weather(source="ng")          National Grid's ~24-month feed, region-keyed (fallback)
//   - WeatherDaily                  Open-Meteo daily temps, ACCOUNT-keyed (always present
//                                   once a sync ran, even when the account has no region)
//
// The bug this guards against: monthly Weather rows are written keyed to the
// account's `region`. If `region` is null (or differs from how rows were keyed)
// the region read returns nothing — yet the account's own daily rows are still
// there. So we ROLL UP the account's daily temps as a fallback, which means
// weather surfaces from the account's own data regardless of `region`.
//
// PURE — no DB/network — so the precedence is unit-tested directly.

import { rollupDailyToMonthly, type DailyTemp } from './openMeteo';

export interface MonthlyWeatherRow {
  ym: number; // YYYYMM
  avgTemperature: number;
  source: string; // "open-meteo" (primary) | "ng" (fallback) | other
}

// Build a ym -> avgTemperature map from the region-keyed monthly rows and the
// account-scoped daily rows. Precedence, highest first:
//   1. monthly Weather with source="open-meteo"
//   2. a rollup of the account's own daily temps (covers region=null / key mismatch)
//   3. any other monthly Weather row (e.g. NG's "ng" fallback)
// Earlier-precedence values are never overwritten by later ones.
export function monthlyTempByYm(
  monthly: MonthlyWeatherRow[],
  daily: DailyTemp[]
): Map<number, number> {
  const out = new Map<number, number>();

  // 1. Primary: full-history Open-Meteo monthly rollup (region-keyed).
  for (const w of monthly) {
    if (w.source === 'open-meteo') out.set(w.ym, w.avgTemperature);
  }

  // 2. Account-scoped daily rollup — fills any month the region rows missed
  //    (the region-null / mismatch case). Same semantics as the monthly rollup.
  for (const m of rollupDailyToMonthly(daily)) {
    if (!out.has(m.ym)) out.set(m.ym, m.avgTemperature);
  }

  // 3. Anything else monthly (NG's "ng" fallback, or future sources) fills gaps.
  for (const w of monthly) {
    if (!out.has(w.ym)) out.set(w.ym, w.avgTemperature);
  }

  return out;
}
