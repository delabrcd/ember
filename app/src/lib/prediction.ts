// Predict the next statement date from historical cadence, and decide when to
// next poll the portal (tightening to daily as the prediction approaches).
// Also estimate the *cost* of that next bill from recent usage + current rates.

import type { MonthRow } from './chartSpec';
import { trailing12AllIn } from './series';

const DAY = 24 * 60 * 60 * 1000;

export function medianIntervalDays(sortedAsc: Date[]): number {
  if (sortedAsc.length < 2) return 30; // sensible default ~monthly
  const gaps: number[] = [];
  for (let i = 1; i < sortedAsc.length; i++) {
    gaps.push((sortedAsc[i].getTime() - sortedAsc[i - 1].getTime()) / DAY);
  }
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
}

export function predictNextBill(statementDates: Date[]): { predicted: Date | null; medianDays: number } {
  if (!statementDates.length) return { predicted: null, medianDays: 30 };
  const sorted = [...statementDates].sort((a, b) => a.getTime() - b.getTime());
  const medianDays = medianIntervalDays(sorted);
  const last = sorted[sorted.length - 1];
  const predicted = new Date(last.getTime() + Math.round(medianDays) * DAY);
  return { predicted, medianDays };
}

// ---------------------------------------------------------------------------
// Wiggle window + back-off cadence (issue #27)
//
// Bills are ~monthly, so polling daily for most of the month wastes requests
// against National Grid. We instead stay idle until we're near the predicted
// next-bill date, ramp to daily inside a window sized from the *historical*
// statement-gap spread, then idle again after the next bill lands (which moves
// the prediction forward and re-derives a fresh, far-out window).
//
// Constants (documented):
//   MIN_WIGGLE_DAYS = 3   floor on the window half-width, so even a perfectly
//                          regular biller still gets a +/-3-day daily window to
//                          catch an early/late statement.
//   WINDOW_K        = 2   how many "spreads" (MAD of the gaps) to fan the window
//                          out by. k=2 keeps the daily window generous enough to
//                          cover normal variability without polling all month.
//   SPARSE_GAP_DAYS = 7   when we're *before* the window we don't poll daily;
//                          we schedule a single sparse safety re-check this far
//                          out (capped at windowStart) so a wildly mis-predicted
//                          date still gets re-evaluated within a week instead of
//                          silently sleeping until a stale windowStart.
// ---------------------------------------------------------------------------

export const MIN_WIGGLE_DAYS = 3;
export const WINDOW_K = 2;
export const SPARSE_GAP_DAYS = 7;

// Spread of the historical statement gaps, as the Median Absolute Deviation
// (MAD) about the median gap. MAD is robust to the occasional off-cadence bill
// (a single 45-day gap won't blow the window open the way a stdev would) and
// pairs naturally with the median interval we predict from. Returns 0 when
// there aren't enough gaps to measure spread (fewer than two gaps).
export function intervalSpreadDays(sortedAsc: Date[]): number {
  if (sortedAsc.length < 3) return 0; // need >=2 gaps to have any spread
  const gaps: number[] = [];
  for (let i = 1; i < sortedAsc.length; i++) {
    gaps.push((sortedAsc[i].getTime() - sortedAsc[i - 1].getTime()) / DAY);
  }
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const m = median(gaps);
  const absdev = gaps.map((g) => Math.abs(g - m));
  return median(absdev);
}

export interface PredictionWindow {
  predicted: Date | null;
  windowStart: Date | null;
  windowEnd: Date | null;
}

// Predicted next-bill date plus the daily-polling window around it. The window
// half-width is max(MIN_WIGGLE_DAYS, WINDOW_K * spread), so a regular biller
// gets the MIN_WIGGLE floor and an irregular one gets a window that scales with
// its own historical variability. Returns all-null when there's no history.
export function predictionWindow(statementDates: Date[]): PredictionWindow {
  const { predicted } = predictNextBill(statementDates);
  if (!predicted) return { predicted: null, windowStart: null, windowEnd: null };
  const sorted = [...statementDates].sort((a, b) => a.getTime() - b.getTime());
  const spread = intervalSpreadDays(sorted);
  const halfDays = Math.max(MIN_WIGGLE_DAYS, WINDOW_K * spread);
  return {
    predicted,
    windowStart: new Date(predicted.getTime() - halfDays * DAY),
    windowEnd: new Date(predicted.getTime() + halfDays * DAY),
  };
}

export interface NextCheckOpts {
  // The full statement history, so the cadence can derive the daily-polling
  // window from historical variability (the default, strong back-off). When
  // omitted we fall back to the legacy predicted-3-days watch window so callers
  // that only know the predicted date keep working.
  statementDates?: Date[];
  // Opt back into the old weekly-heartbeat-everywhere behavior (kept for
  // compatibility / tests). Default false: we use the issue-#27 back-off.
  legacy?: boolean;
}

// Decide when to next poll the portal. DEFAULT cadence (strong back-off):
//   - before windowStart  -> idle: schedule a single SPARSE safety re-check
//                            (now + SPARSE_GAP_DAYS), capped at windowStart so
//                            we never sleep past the window opening.
//   - inside [windowStart, windowEnd] AND beyond windowEnd (until a new bill
//     arrives and moves the window) -> daily (now + 1 day).
// Pure function of (now, window). With no prediction (first run / no history)
// we fall back to a sensible "check soon" of SPARSE_GAP_DAYS out.
//
// `predicted` is kept as the first arg for backward compatibility; pass the
// statement history via opts to get the windowed back-off. Without it (or with
// legacy:true) we reproduce the original predicted-3-day / weekly behavior.
export function computeNextCheck(now: Date, predicted: Date | null, opts?: NextCheckOpts): Date {
  // Legacy mode (or a caller that only has the predicted date): weekly far out,
  // daily inside predicted-3d. Preserved for compatibility and existing tests.
  if (opts?.legacy || !opts?.statementDates) {
    if (!predicted) return new Date(now.getTime() + (opts?.legacy ? 7 : SPARSE_GAP_DAYS) * DAY);
    const watchStart = new Date(predicted.getTime() - MIN_WIGGLE_DAYS * DAY);
    if (now < watchStart) {
      if (!opts?.legacy) {
        const sparse = new Date(now.getTime() + SPARSE_GAP_DAYS * DAY);
        return sparse < watchStart ? sparse : watchStart;
      }
      const weekly = new Date(now.getTime() + 7 * DAY);
      return weekly < watchStart ? weekly : watchStart;
    }
    return new Date(now.getTime() + 1 * DAY);
  }

  // Default back-off: derive the window from history.
  const { windowStart } = predictionWindow(opts.statementDates);
  if (!windowStart) return new Date(now.getTime() + SPARSE_GAP_DAYS * DAY);
  if (now < windowStart) {
    // Idle: one sparse safety re-check, never past the window opening.
    const sparse = new Date(now.getTime() + SPARSE_GAP_DAYS * DAY);
    return sparse < windowStart ? sparse : windowStart;
  }
  // Inside the window or past it with no new bill yet: poll daily.
  return new Date(now.getTime() + 1 * DAY);
}

// ---------------------------------------------------------------------------
// Next-bill COST estimate (issue #9)
//
// Predicts the dollar amount of the upcoming bill — purely from the monthly
// series — so it can sit next to the predicted *date* on the Overview. It is an
// estimate, not a real charge: we never store it and it never feeds /api/verify.
//
// Model (kept deliberately simple and explainable):
//   1. Target period = the calendar month after the most recent row that has
//      usage (ym + 1 month; December rolls to January of the next year).
//   2. Project next-period USAGE per fuel. Energy use is strongly seasonal, so
//      the preferred basis is the *same calendar month one year ago*. If that
//      month is missing (or has no usage for that fuel) we fall back to the
//      trailing-N-month average of the most recent rows that have that fuel's
//      usage (default N = 3). Each fuel is projected independently.
//   3. Cost = projected_kWh × elec all-in $/kWh
//           + projected_therms × gas all-in $/therm,
//      where the all-in $/unit is trailing12AllIn() from series.ts — i.e. the
//      same trailing-12-month PDF-sourced (currentCharges) rate the headline
//      cards use. This is the period energy charge basis, NOT the API amount due.
//   4. Confidence band from historical variability of the period energy cost
//      (billTotal = currentCharges). We take the sample standard deviation of
//      the trailing-N period costs and band the point estimate by ±k·stdev
//      (k = 1), flooring low at 0. With <2 cost samples we fall back to a
//      documented ±DEFAULT_BAND_PCT band so the range is still meaningful.
//
// Returns null when there isn't enough data to project either fuel at a rate.
// ---------------------------------------------------------------------------

export interface NextBillEstimate {
  point: number;
  low: number;
  high: number;
  basis: string; // human-readable note on how usage was projected
}

export interface EstimateOpts {
  trailingMonths?: number; // N for the trailing-average fallback (default 3)
  bandStdevs?: number; // k: half-width of the band in stdevs (default 1)
}

const DEFAULT_TRAILING = 3;
const DEFAULT_BAND_STDEVS = 1;
const DEFAULT_BAND_PCT = 0.15; // ±15% fallback when stdev isn't computable

// Calendar month after `ym` (yyyymm), rolling Dec -> Jan of the next year.
function nextYm(ym: number): number {
  const y = Math.floor(ym / 100);
  const m = ym % 100;
  return m >= 12 ? (y + 1) * 100 + 1 : y * 100 + (m + 1);
}

// Sample standard deviation (n-1). Returns null for fewer than two values.
function sampleStdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

// Project one fuel's next-period usage: same calendar month last year if we
// have it, else the trailing-N average. Returns the value and which basis won.
function projectUsage(
  rows: MonthRow[],
  targetYm: number,
  key: 'kwh' | 'therms',
  trailing: number,
): { value: number; usedLastYear: boolean } | null {
  const lastYear = rows.find((r) => r.ym === targetYm - 100 && r[key] != null);
  if (lastYear) return { value: lastYear[key] as number, usedLastYear: true };

  const recent = rows.filter((r) => r[key] != null).slice(-trailing);
  if (!recent.length) return null;
  const avg = recent.reduce((s, r) => s + (r[key] as number), 0) / recent.length;
  return { value: avg, usedLastYear: false };
}

export function estimateNextBill(rows: MonthRow[], opts?: EstimateOpts): NextBillEstimate | null {
  if (!rows.length) return null;
  const trailing = opts?.trailingMonths ?? DEFAULT_TRAILING;
  const k = opts?.bandStdevs ?? DEFAULT_BAND_STDEVS;

  // Target the month after the latest row that actually carries usage.
  const lastUsage = [...rows].reverse().find((r) => r.kwh != null || r.therms != null);
  if (!lastUsage) return null;
  const targetYm = nextYm(lastUsage.ym);

  const elecRate = trailing12AllIn(rows, 'elec');
  const gasRate = trailing12AllIn(rows, 'gas');
  const elecUse = projectUsage(rows, targetYm, 'kwh', trailing);
  const gasUse = projectUsage(rows, targetYm, 'therms', trailing);

  // Only count a fuel if we can both project its usage AND price it.
  const elecCost = elecUse && elecRate != null ? elecUse.value * elecRate : null;
  const gasCost = gasUse && gasRate != null ? gasUse.value * gasRate : null;
  if (elecCost == null && gasCost == null) return null;

  const point = (elecCost ?? 0) + (gasCost ?? 0);

  // Confidence band from the spread of recent period energy costs (billTotal).
  const recentCosts = rows
    .filter((r) => r.billTotal != null)
    .slice(-trailing)
    .map((r) => r.billTotal as number);
  const stdev = sampleStdev(recentCosts);
  const half = stdev != null ? k * stdev : DEFAULT_BAND_PCT * point;
  const low = Math.max(0, point - half);
  const high = point + half;

  // Describe the projection basis per fuel so the UI can caption it honestly.
  const parts: string[] = [];
  if (elecCost != null) parts.push(`electric ${elecUse!.usedLastYear ? 'same month last year' : `trailing ${trailing}-mo avg`}`);
  if (gasCost != null) parts.push(`gas ${gasUse!.usedLastYear ? 'same month last year' : `trailing ${trailing}-mo avg`}`);
  const bandNote = stdev != null ? `±1σ of recent costs` : `±${Math.round(DEFAULT_BAND_PCT * 100)}%`;
  const basis = `${parts.join(', ')}; current 12-mo all-in rates; ${bandNote}`;

  return { point, low, high, basis };
}
