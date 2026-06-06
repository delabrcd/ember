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

// Cadence: weekly heartbeat far out; daily once inside the watch window
// (predicted - 3 days) and until a new bill arrives.
export function computeNextCheck(now: Date, predicted: Date | null): Date {
  if (!predicted) return new Date(now.getTime() + 7 * DAY);
  const watchStart = new Date(predicted.getTime() - 3 * DAY);
  if (now < watchStart) {
    const weekly = new Date(now.getTime() + 7 * DAY);
    return weekly < watchStart ? weekly : watchStart;
  }
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
