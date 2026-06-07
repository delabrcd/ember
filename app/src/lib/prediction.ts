// Predict the next statement date from historical cadence, and decide when to
// next poll the portal (tightening to daily as the prediction approaches).
// Also estimate the *cost* of that next bill from recent usage + current rates.

import type { MonthRow } from './chartSpec';
import { trailing12AllIn } from './series';
import { ymAddMonths, ymLabel } from './ym';

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

// Decide when to next poll the portal. Strong back-off (issue #27) derived from
// the statement history's predicted-bill window:
//   - before windowStart  -> idle: schedule a single SPARSE safety re-check
//                            (now + SPARSE_GAP_DAYS), capped at windowStart so
//                            we never sleep past the window opening.
//   - inside [windowStart, windowEnd] AND beyond windowEnd (until a new bill
//     arrives and moves the window) -> daily (now + 1 day).
// Pure function of (now, statementDates). With no history (first run) we fall
// back to a sensible "check soon" of SPARSE_GAP_DAYS out.
export function computeNextCheck(now: Date, statementDates: Date[]): Date {
  const { windowStart } = predictionWindow(statementDates);
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
const nextYm = (ym: number): number => ymAddMonths(ym, 1);

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

// ---------------------------------------------------------------------------
// Degree-day USAGE regression (issue #44)
//
// The #9 estimate above projects next-period usage from the calendar (same
// month last year / trailing average). That ignores *how cold/hot* the coming
// window will actually be. This block adds a weather-driven projection: fit
// usage against degree-days from history, then project usage from the EXPECTED
// degree-days for the predicted bill window (forecast + climatological normals,
// assembled impurely in the data layer) and price it with the same PDF-sourced
// trailing-12 all-in rate. Like #9 it is an estimate — never stored, never fed
// to /api/verify.
//
// Models (ordinary least squares, one fit per fuel):
//   electric: kWh    ≈ baseElec + slopeC·CDD + slopeH·HDD   (two regressors)
//   gas:      therms ≈ baseGas  + slopeH·HDD                (one regressor)
// Electric tracks both heating (resistive/heat-pump aux) and cooling (A/C); gas
// is heating-only here, matching the weather-normalization split in series.ts.
//
// Everything in this block is PURE (no DB/network/React) so the arithmetic is
// unit-tested with hand-calculated slopes/intercepts. The impure expected-
// degree-day assembly lives in lib/weather/expectedDegreeDays.ts and feeds the
// pure projector below.
// ---------------------------------------------------------------------------

// Minimum number of usable (usage + HDD + CDD) rows before we trust a fit.
// Electric has two regressors + an intercept (3 params); gas has one + intercept
// (2 params). We require a few observations beyond the parameter count so a fit
// reflects a real relationship rather than interpolating the points exactly:
//   - electric: >= 4 rows (3 params + 1)  -> MIN_FIT_ROWS_ELEC
//   - gas:      >= 3 rows (2 params + 1)  -> MIN_FIT_ROWS_GAS
export const MIN_FIT_ROWS_ELEC = 4;
export const MIN_FIT_ROWS_GAS = 3;

// A fit we'd refuse to project from is "degenerate": too few rows, or the
// degree-day regressor(s) carry near-zero variance so the normal equations are
// (near-)singular and the slope is meaningless. We treat |det| <= EPS of the
// normal matrix as non-invertible.
const FIT_DET_EPS = 1e-9;

// One observation for the fit: usage against the period's degree-days. Built by
// the caller from MonthRow (kwh/therms + hdd/cdd); kept tiny so the fit is pure.
export interface FitObservation {
  usage: number;
  hdd: number;
  cdd: number;
}

// Result of a per-fuel OLS fit. `ok:false` means degenerate -> caller falls back.
// On success: coefficients, the residual standard deviation (sample, n-params)
// used to size the projection band, and the observation count behind the fit.
export type UsageFit =
  | { ok: false; reason: 'insufficient' | 'degenerate' }
  | {
      ok: true;
      base: number;
      slopeH: number; // kWh or therms per HDD
      slopeC: number; // kWh per CDD (0 for the gas one-regressor model)
      residualStdev: number; // sample stdev of residuals (n - params); 0 if undefinable
      n: number;
    };

// Expected degree-days for the predicted bill window, plus how that expectation
// was sourced, so the caller can caption the basis honestly. `forecastDays` is
// how many days came from the live forecast; `normalDays` from climatological
// normals; their sum is the window length.
export interface ExpectedDegreeDays {
  hdd: number;
  cdd: number;
  forecastDays: number;
  normalDays: number;
}

// Mean of a list (0 for empty — callers guard length first).
const meanOf = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// --- ELECTRIC: two-regressor OLS  kWh ≈ b + c·CDD + h·HDD --------------------
//
// Solve the 3×3 normal equations XᵀX β = Xᵀy with X columns [1, CDD, HDD]. We
// center CDD/HDD on their means so the intercept decouples (b = ȳ, and the 2×2
// system in the slopes uses centered cross-products); this keeps the hand
// arithmetic tractable and the matrix well-conditioned. Degenerate when the
// centered 2×2 has a near-zero determinant (no usable degree-day variance).
export function fitElectric(obs: FitObservation[]): UsageFit {
  if (obs.length < MIN_FIT_ROWS_ELEC) return { ok: false, reason: 'insufficient' };
  const n = obs.length;
  const ybar = meanOf(obs.map((o) => o.usage));
  const cbar = meanOf(obs.map((o) => o.cdd));
  const hbar = meanOf(obs.map((o) => o.hdd));

  // Centered sums of squares / cross-products.
  let Scc = 0, Shh = 0, Sch = 0, Scy = 0, Shy = 0;
  for (const o of obs) {
    const dc = o.cdd - cbar;
    const dh = o.hdd - hbar;
    const dy = o.usage - ybar;
    Scc += dc * dc;
    Shh += dh * dh;
    Sch += dc * dh;
    Scy += dc * dy;
    Shy += dh * dy;
  }
  const det = Scc * Shh - Sch * Sch;
  if (Math.abs(det) <= FIT_DET_EPS) return { ok: false, reason: 'degenerate' };

  // Cramer's rule on the centered 2×2: [Scc Sch; Sch Shh][slopeC; slopeH] = [Scy; Shy].
  const slopeC = (Scy * Shh - Shy * Sch) / det;
  const slopeH = (Shy * Scc - Scy * Sch) / det;
  const base = ybar - slopeC * cbar - slopeH * hbar;

  const residualStdev = residualSpread(
    obs.map((o) => o.usage - (base + slopeC * o.cdd + slopeH * o.hdd)),
    3
  );
  return { ok: true, base, slopeH, slopeC, residualStdev, n };
}

// --- GAS: one-regressor OLS  therms ≈ b + h·HDD -----------------------------
//
// Simple linear regression of therms on HDD. Degenerate when HDD has near-zero
// variance (Shh ≈ 0). slopeC is fixed at 0 (gas has no cooling term).
export function fitGas(obs: FitObservation[]): UsageFit {
  if (obs.length < MIN_FIT_ROWS_GAS) return { ok: false, reason: 'insufficient' };
  const n = obs.length;
  const ybar = meanOf(obs.map((o) => o.usage));
  const hbar = meanOf(obs.map((o) => o.hdd));
  let Shh = 0, Shy = 0;
  for (const o of obs) {
    const dh = o.hdd - hbar;
    Shh += dh * dh;
    Shy += dh * (o.usage - ybar);
  }
  if (Math.abs(Shh) <= FIT_DET_EPS) return { ok: false, reason: 'degenerate' };
  const slopeH = Shy / Shh;
  const base = ybar - slopeH * hbar;
  const residualStdev = residualSpread(obs.map((o) => o.usage - (base + slopeH * o.hdd)), 2);
  return { ok: true, base, slopeH, slopeC: 0, residualStdev, n };
}

// Sample stdev of regression residuals with `params` degrees of freedom removed
// (residual standard error). Returns 0 when n <= params (band undefinable).
function residualSpread(residuals: number[], params: number): number {
  const dof = residuals.length - params;
  if (dof <= 0) return 0;
  const ss = residuals.reduce((s, r) => s + r * r, 0);
  return Math.sqrt(ss / dof);
}

// Build the per-fuel observation list from the series: rows that carry BOTH the
// fuel's usage and degree-days. Electric uses HDD+CDD; gas uses HDD (cdd kept 0
// for the gas model). PURE.
export function fitObservations(rows: MonthRow[], fuel: 'elec' | 'gas'): FitObservation[] {
  const useKey: 'kwh' | 'therms' = fuel === 'elec' ? 'kwh' : 'therms';
  const out: FitObservation[] = [];
  for (const r of rows) {
    const usage = r[useKey];
    if (usage == null || r.hdd == null) continue;
    if (fuel === 'elec' && r.cdd == null) continue;
    out.push({ usage, hdd: r.hdd, cdd: r.cdd ?? 0 });
  }
  return out;
}

// Convenience wrapper: fit both fuels from the series at once. PURE.
export function fitUsageVsDegreeDays(rows: MonthRow[]): { elec: UsageFit; gas: UsageFit } {
  return {
    elec: fitElectric(fitObservations(rows, 'elec')),
    gas: fitGas(fitObservations(rows, 'gas')),
  };
}

// ---------------------------------------------------------------------------
// Seasonal 12-month projection (issue #52)
//
// Where #44 projects ONE upcoming bill from the predicted window's weather, this
// projects the next TWELVE calendar months — a full year out — purely from the
// climatological NORMALS (no forecast: a year ahead there is none). For each of
// the 12 months after the latest row we:
//   1. take that month's expected NORMAL HDD/CDD (assembled impurely in the data
//      layer from cached day-of-year normals and passed in as a lookup), then
//   2. project per-fuel usage from the #44 OLS fit (electric HDD+CDD, gas HDD),
//   3. price it with trailing12AllIn() — the same PDF-sourced (currentCharges)
//      all-in $/unit the headline cards and #44 use, NOT the API amount due, and
//   4. band each month, WIDENING the band with the horizon (see below).
// We also return the 12-month annual total with a combined band.
//
// FALLBACK (per fuel, per month): when a fuel's fit isn't usable (degenerate /
// insufficient) OR that month has no normals, we fall back to the SAME CALENDAR
// MONTH ONE YEAR AGO's usage (priced at current rates) for that fuel and flag the
// month `fallback: true`. A month with neither a usable fit-projection nor a
// same-month-last-year value for either fuel still produces a point (0 for the
// missing fuel) but is flagged as a fallback.
//
// BAND-WIDENING RULE (documented + tested):
//   monthHalf(h) = k · residualStdev · sqrt(h)          (h = 1-based horizon)
// The 1-month-out projection gets the base ±k·σ regression band; each further
// month out compounds projection error roughly like an independent step, so the
// band variance grows ~linearly with the horizon and the half-width ~sqrt(h)
// (random-walk / sqrt-of-time growth). A year out (h=12) the band is sqrt(12) ≈
// 3.46× the one-month band — honestly signalling that a climatological projection
// degrades with distance. The annual band combines the 12 monthly halves in
// quadrature (independent monthly residuals), with the same ±15% floor #44 uses
// when every contributing residual spread is 0.
//
// Everything here is PURE (no DB/network/React): the normals lookup and rates are
// passed in. The impure normals assembly lives in lib/weather/expectedDegreeDays
// Sync.ts and feeds this projector.
// ---------------------------------------------------------------------------

// One projected future bill period.
export interface SeasonMonth {
  ym: number; // YYYYMM of the projected calendar month
  label: string; // 'YYYY-MM'
  projKwh: number | null; // projected electric usage (null when electric can't be projected)
  projTherms: number | null; // projected gas usage (null when gas can't be projected)
  projCost: number; // projected period energy cost ($), priced at per-component Kalman fixed+variable rates (flat all-in rates on the sparse-history fallback)
  low: number; // lower band (floored at 0)
  high: number; // upper band
  fallback: boolean; // true when ANY fuel used same-month-last-year instead of the fit
}

export interface SeasonProjection {
  months: SeasonMonth[];
  annual: { point: number; low: number; high: number }; // sum of the 12 points, banded in quadrature
  basis: string; // human-readable note on how the season was projected
}

export interface SeasonOpts {
  bandStdevs?: number; // k: base half-width in stdevs (default 1)
  horizonK?: number; // unused scalar hook; kept for symmetry, default 1
}

// Same calendar month one year before `ym` (subtract 12 months).
const sameMonthLastYearYm = (ym: number): number => ymAddMonths(ym, -12);

// Project one fuel's usage for a future month: prefer the fit + that month's
// normal degree-days; fall back to the same-month-last-year usage when the fit is
// unusable OR the month has no normals. Returns the projected usage, its band
// half-width contribution (before horizon widening), and which basis was used —
// or null when neither path can produce a value for this fuel/month. PURE.
function projectFuelMonth(
  rows: MonthRow[],
  ym: number,
  fuel: 'elec' | 'gas',
  fit: UsageFit,
  normals: ExpectedDegreeDays | undefined,
  k: number
): { usage: number; baseHalf: number; usedFallback: boolean } | null {
  const useKey: 'kwh' | 'therms' = fuel === 'elec' ? 'kwh' : 'therms';
  if (fit.ok && normals) {
    const usage = Math.max(0, fit.base + fit.slopeC * normals.cdd + fit.slopeH * normals.hdd);
    return { usage, baseHalf: k * fit.residualStdev, usedFallback: false };
  }
  // Fallback: same calendar month last year's usage for this fuel.
  const ly = rows.find((r) => r.ym === sameMonthLastYearYm(ym) && r[useKey] != null);
  if (ly) return { usage: ly[useKey] as number, baseHalf: 0, usedFallback: true };
  return null;
}

export function projectSeason(
  rows: MonthRow[],
  normalsByMonth: Map<number, ExpectedDegreeDays>,
  rates: { elec: number | null; gas: number | null },
  opts?: SeasonOpts
): SeasonProjection {
  const k = opts?.bandStdevs ?? DEFAULT_BAND_STDEVS;
  const empty: SeasonProjection = { months: [], annual: { point: 0, low: 0, high: 0 }, basis: 'no data' };

  // Anchor on the latest row that actually carries usage; project the 12 calendar
  // months after it.
  const lastUsage = [...rows].reverse().find((r) => r.kwh != null || r.therms != null);
  if (!lastUsage) return empty;

  const fits = fitUsageVsDegreeDays(rows);

  // ---- Pricing mode (issue #72) -------------------------------------------
  // Prefer the #67 per-component Kalman fixed+variable rate model: price each
  // forward month as (Σ fixedPerDay)·days + (Σ rate)·usage per fuel, so a
  // near-zero-usage summer gas month costs ≈ its fixed delivery charge instead
  // of ~$0. The Kalman state is a random walk (no drift), so its filtered
  // estimate is the best forecast for ALL 12 forward months — compute the four
  // component rates ONCE here and reuse them every month. When there isn't
  // enough history (fewer than MIN_SEASONAL_BILLS usable component bills, or any
  // of the four rates can't be estimated) we fall back to the flat all-in
  // `rates` pricing for sparse-history / new accounts.
  const [es, ed, gs, gd] = COMPONENT_PICKS.map((p) => kalmanComponentRate(rows, p));
  const usableBills = COMPONENT_PICKS.reduce(
    (m, p) => Math.max(m, componentUsableRows(rows, p).length),
    0
  );
  const useComponents =
    usableBills >= MIN_SEASONAL_BILLS && es != null && ed != null && gs != null && gd != null;
  // Per-fuel variable $/unit (supply + delivery) used both to price usage and to
  // convert the usage-residual band half-width to $ in component mode.
  const elecVarRate = useComponents ? es!.rate + ed!.rate : 0;
  const gasVarRate = useComponents ? gs!.rate + gd!.rate : 0;

  // Period length for the fixed term: median of the historical non-null days
  // (fallback 30), computed once before the loop.
  const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const dayVals = rows.map((r) => r.days).filter((d): d is number => d != null);
  const days = dayVals.length ? median(dayVals) : 30;

  const months: SeasonMonth[] = [];
  let anyFit = false;
  let anyFallback = false;

  for (let h = 1; h <= 12; h++) {
    const ym = ymAddMonths(lastUsage.ym, h);
    const normals = normalsByMonth.get(ym);

    // In component mode the usage projection itself never needs `rates`, so we
    // always attempt both fuels; in flat mode we keep the old guard that a fuel
    // is only projected when it has a flat rate.
    const elec =
      useComponents || rates.elec != null
        ? projectFuelMonth(rows, ym, 'elec', fits.elec, normals, k)
        : null;
    const gas =
      useComponents || rates.gas != null
        ? projectFuelMonth(rows, ym, 'gas', fits.gas, normals, k)
        : null;

    let elecCost: number;
    let gasCost: number;
    if (useComponents) {
      // Fixed charge accrues even at ~0 usage; variable charge scales with use.
      elecCost = elec ? (es!.fixedPerDay + ed!.fixedPerDay) * days + elecVarRate * elec.usage : 0;
      gasCost = gas ? (gs!.fixedPerDay + gd!.fixedPerDay) * days + gasVarRate * gas.usage : 0;
    } else {
      elecCost = elec ? elec.usage * rates.elec! : 0;
      gasCost = gas ? gas.usage * rates.gas! : 0;
    }
    const projCost = elecCost + gasCost;

    // Per-fuel base band in $; widen by sqrt(h) for the horizon, combine in
    // quadrature across fuels. The usage residual carries no fixed-charge
    // uncertainty, so in component mode it converts to $ via the per-fuel
    // VARIABLE rate; in flat mode via the flat all-in rate (unchanged).
    const grow = Math.sqrt(h);
    const elecRate$ = useComponents ? elecVarRate : rates.elec ?? 0;
    const gasRate$ = useComponents ? gasVarRate : rates.gas ?? 0;
    const elecHalf = elec ? elec.baseHalf * elecRate$ * grow : 0;
    const gasHalf = gas ? gas.baseHalf * gasRate$ * grow : 0;
    let half = Math.sqrt(elecHalf ** 2 + gasHalf ** 2);
    if (half <= 0) half = DEFAULT_BAND_PCT * projCost; // ±15% floor when residual-flat

    const usedFallback = Boolean(elec?.usedFallback || gas?.usedFallback);
    if (elec && !elec.usedFallback) anyFit = true;
    if (gas && !gas.usedFallback) anyFit = true;
    if (usedFallback) anyFallback = true;

    months.push({
      ym,
      label: ymLabel(ym),
      projKwh: elec ? elec.usage : null,
      projTherms: gas ? gas.usage : null,
      projCost,
      low: Math.max(0, projCost - half),
      high: projCost + half,
      fallback: usedFallback,
    });
  }

  const point = months.reduce((s, m) => s + m.projCost, 0);
  // Annual band: combine the 12 monthly half-widths in quadrature (independent
  // monthly residuals); fall back to ±15% of the annual point if every month
  // collapsed to the residual-flat floor would still be 0.
  const annualHalfSq = months.reduce((s, m) => s + ((m.high - m.projCost) ** 2), 0);
  let annualHalf = Math.sqrt(annualHalfSq);
  if (annualHalf <= 0) annualHalf = DEFAULT_BAND_PCT * point;

  const rateNote = useComponents
    ? 'per-component Kalman fixed+variable rates'
    : 'current 12-mo all-in rates';
  const basis = anyFit
    ? `12-month climatological projection from degree-day normals; ${rateNote}${
        anyFallback ? '; some months fell back to same-month-last-year usage' : ''
      }`
    : `same-month-last-year usage at ${rateNote} (climatological fallback)`;

  return {
    months,
    annual: { point, low: Math.max(0, point - annualHalf), high: point + annualHalf },
    basis,
  };
}

// Turn a SeasonProjection into FUTURE MonthRows the declarative cost/usage charts
// can render as a forward dashed series, appended after the historical rows. Each
// forward row carries ONLY the projection fields (projCost/projKwh/projTherms);
// every historical chart field is null so it draws nothing on the solid series.
//
// To make the dashed line visually CONNECT to the solid history, we also stamp
// the anchor's projCost onto the latest historical row (mutating a shallow copy
// is avoided — the caller passes the real series and we return only the new rows;
// the caller stamps the anchor). Returns [] when there's nothing to project. PURE.
export function seasonForwardRows(projection: SeasonProjection): MonthRow[] {
  return projection.months.map((m) => ({
    ym: m.ym,
    label: m.label,
    kwh: null,
    therms: null,
    elecSupply: null,
    gasSupply: null,
    elecDelivery: null,
    gasDelivery: null,
    elecBill: null,
    gasBill: null,
    elecRateSupply: null,
    gasRateSupply: null,
    elecRateAllIn: null,
    gasRateAllIn: null,
    avgTemp: null,
    billTotal: null,
    days: null,
    hdd: null,
    cdd: null,
    kwhPerDegreeDay: null,
    thermsPerHdd: null,
    projCost: m.projCost,
    projKwh: m.projKwh,
    projTherms: m.projTherms,
  }));
}

// ---------------------------------------------------------------------------
// Seasonal next-bill estimate (issue #67) — Kalman-filtered component rates
//
// A faithful TypeScript port of the proven Python POC (ngrid-poc-67). It beats
// the calendar #9 estimate by ~2x on the real account (POC back-test: MAPE
// 15.4%→6.9%, MAE $31→$14.9) using only production-realizable inputs. Two parts:
//
//   1. WEATHER-AWARE USAGE. Per-fuel OLS of usage vs degree-days (the #44 fit,
//      reused here), projected onto the predicted next-bill window's degree-days
//      (forecast + climatological normals, assembled impurely and passed in via
//      opts.target). This is the same projection projectSeason() makes for its
//      first forward month. UNCHANGED from V3.
//   2. PER-COMPONENT RATE via a KALMAN FILTER (see kalmanComponentRate). For each
//      of the four components (electric supply, electric delivery, gas supply,
//      gas delivery) the latent state [fixed $/day, variable $/unit] is a random
//      walk; each historical bill is a linear observation
//      amount ≈ fixed·days + rate·usage and the filter tracks the DRIFTING rate
//      level, returning a one-step-ahead projection for the next period. This is
//      the structural fix (it prices near-zero-usage summer gas delivery as
//      mostly its fixed customer charge, where a flat $/therm fails) AND removes
//      both of V3's hacks: there is NO recent-window length and NO manual
//      trailing bias term — the filter yields ≈0 bias on its own (FINDINGS).
//      Degenerate fits fall back to a mean $/unit, exactly like the POC.
//
// The bill total is the sum of the four component predictions (each fixed·days +
// rate·usage) — the POC verified the four components sum to currentCharges.
// Everything here is PURE: the impure target-window degree-day assembly
// (forecast + normals) and the rate inputs are passed in by the caller.
//
// The CONFIDENCE BAND is sized from the spread of WALK-FORWARD residuals
// (actual_i − model trained ONLY on bills before i), pricing each historical
// bill from its OWN actual period degree-days/days — the POC showed actual- and
// normal-weather back-tests give essentially the same error (the "ceiling" row
// in FINDINGS), so this stays self-contained without recomputing per-window
// normals. (No bias is added back; only the spread sizes the band.)
//
// Falls back to estimateNextBill (#9) — the caller does this — when there isn't
// enough data: fewer than MIN_SEASONAL_BILLS usable bills, the four components /
// degree-days are missing, or no target-window degree-days were supplied.
// ---------------------------------------------------------------------------

// Number of leading usable bills used to seed the Kalman filter's initial state
// (OLS on the first ~4 bills -> x0). Mirrors the POC's _init_ols(n=4).
export const KALMAN_INIT_BILLS = 4;
// Kalman tuning constants (POC `kalman.py`, FINDINGS recommendation). q is the
// per-step process drift as a FRACTION of each state's magnitude; r is the
// observation-noise scale as a FRACTION of the component's mean amount. The
// back-test plateau is broad (q∈[0.10–0.25], r∈[0.06–0.15] all ~MAE $15); we
// take the mid-plateau q=0.15, r=0.10.
export const KALMAN_Q_FRAC = 0.15;
export const KALMAN_R_FRAC = 0.1;
// Minimum usable bills before we trust the seasonal model; below this the caller
// falls back to #9. The POC's walk-forward used min_train = 18.
export const MIN_SEASONAL_BILLS = 18;

// The four cost components, each paired with the usage column that drives it.
export type ComponentPick =
  | { usage: 'kwh'; comp: 'elecSupply' }
  | { usage: 'kwh'; comp: 'elecDelivery' }
  | { usage: 'therms'; comp: 'gasSupply' }
  | { usage: 'therms'; comp: 'gasDelivery' };

export const COMPONENT_PICKS: ComponentPick[] = [
  { usage: 'kwh', comp: 'elecSupply' },
  { usage: 'kwh', comp: 'elecDelivery' },
  { usage: 'therms', comp: 'gasSupply' },
  { usage: 'therms', comp: 'gasDelivery' },
];

// A component's decomposed price: a fixed daily charge plus a variable per-unit
// rate, so amount ≈ fixedPerDay·days + rate·usage.
export interface ComponentRate {
  fixedPerDay: number;
  rate: number;
}

// Solve the 2-parameter no-intercept OLS  y ≈ b0·x0 + b1·x1 by the normal
// equations (XᵀX)β = Xᵀy via Cramer's rule on the 2×2 — matching numpy's
// lstsq for a two-column design. Returns null when the system is singular
// (near-zero determinant: the two columns are collinear / no usable variance).
const OLS2_DET_EPS = 1e-9;
function ols2(x0: number[], x1: number[], y: number[]): { b0: number; b1: number } | null {
  let s00 = 0, s01 = 0, s11 = 0, s0y = 0, s1y = 0;
  for (let i = 0; i < y.length; i++) {
    s00 += x0[i] * x0[i];
    s01 += x0[i] * x1[i];
    s11 += x1[i] * x1[i];
    s0y += x0[i] * y[i];
    s1y += x1[i] * y[i];
  }
  const det = s00 * s11 - s01 * s01;
  if (Math.abs(det) <= OLS2_DET_EPS) return null;
  const b0 = (s0y * s11 - s1y * s01) / det;
  const b1 = (s00 * s1y - s01 * s0y) / det;
  return { b0, b1 };
}

// The component's usable bills (carrying the component, its usage AND a period
// length) in chronological order. Rows missing `days` are skipped (the fixed
// term is meaningless without a period length).
function componentUsableRows(rows: MonthRow[], pick: ComponentPick): MonthRow[] {
  return rows.filter(
    (r) => r[pick.usage] != null && r[pick.comp] != null && r.days != null && r.days > 0
  );
}

// Fit one cost component's price as fixed $/day + variable $/unit by a 2-param
// no-intercept OLS over the given usable rows:
//   amount ≈ fixedPerDay·days + rate·usage
// Guard against a degenerate fit (negative fixed or rate, or a singular system)
// by falling back to a mean $/unit with the leftover as the fixed floor —
// exactly the POC's fallback. Returns null when fewer than 3 usable bills are
// supplied. This is the Kalman filter's INITIAL-state seed (POC `_init_ols`)
// and the per-component degenerate fallback.
export function fitComponentRate(
  rows: MonthRow[],
  pick: ComponentPick
): ComponentRate | null {
  const sub = componentUsableRows(rows, pick);
  if (sub.length < 3) return null;

  const days = sub.map((r) => r.days as number);
  const usage = sub.map((r) => r[pick.usage] as number);
  const amount = sub.map((r) => r[pick.comp] as number);

  const fit = ols2(days, usage, amount);
  let fixedPerDay = fit?.b0 ?? -1;
  let rate = fit?.b1 ?? -1;

  if (!fit || rate < 0 || fixedPerDay < 0 || !Number.isFinite(rate) || !Number.isFinite(fixedPerDay)) {
    // Degenerate fit -> fall back to mean $/unit, fixed = leftover / total days.
    const totalUse = usage.reduce((a, b) => a + b, 0);
    const totalAmt = amount.reduce((a, b) => a + b, 0);
    const totalDays = days.reduce((a, b) => a + b, 0);
    rate = totalUse > 5 ? Math.max(0, totalAmt / totalUse) : 0;
    fixedPerDay = totalDays > 0 ? Math.max(0, (totalAmt - rate * totalUse) / totalDays) : 0;
  }
  return { fixedPerDay: Math.max(0, fixedPerDay), rate: Math.max(0, rate) };
}

// ---------------------------------------------------------------------------
// Kalman-filter component rate (issue #67, follow-up — BEST model)
//
// Per cost component the latent state x = [fixedPerDay, ratePerUnit] evolves as
// a RANDOM WALK (F = I): the underlying fixed customer charge and variable
// $/unit drift slowly over time. Each historical bill (chronological) is a
// linear observation
//   amount = days·fixedPerDay + usage·ratePerUnit + noise
// i.e. a time-varying observation row H_t = [days_t, usage_t] with scalar
// measurement z = the component's amount. We run the standard KF predict/update
// per bill, then take ONE final predict step (x_pred = F·x) and return the
// projected (fixedPerDay, ratePerUnit) for the NEXT period, clamped ≥ 0.
//
// This replaces V3's recent-6-month window + manual trailing bias correction
// with one principled estimator: the filter tracks the drifting rate level and
// yields ≈0 bias on its own (POC back-test: MAE $14.9 / 6.9% vs V3+bias $16.4 /
// 7.8%, and removes BOTH hacks). The trend (local-linear) variant back-tested
// WORSE and is intentionally NOT ported.
//
// Init / tuning (ported exactly from `kalman_rate`):
//   x0 = OLS on the first ~4 usable bills (reuse fitComponentRate).
//   P0 = 4 · diag((0.5·max(0.1,|f0|))², (0.5·max(1e-3,|r0|))²)
//   Q  = diag((q·max(0.1,|f0|))², (q·max(1e-3,|r0|))²)   (drift ∝ magnitude)
//   R  = (r · max(5, mean(amount over training)))²
// with q = KALMAN_Q_FRAC (0.15), r = KALMAN_R_FRAC (0.10). With fewer than 4
// usable bills we fall back to the initial OLS (as the POC does). It's a 2×2 /
// 2-vector filter, implemented with plain number arrays (no dependency).
// ---------------------------------------------------------------------------

// Small fixed-size types for the 2-state filter. Vectors are [a,b]; 2×2 matrices
// are [[a,b],[c,d]].
type Vec2 = [number, number];
type Mat2 = [[number, number], [number, number]];

export function kalmanComponentRate(
  rows: MonthRow[],
  pick: ComponentPick,
  qFrac = KALMAN_Q_FRAC,
  rFrac = KALMAN_R_FRAC
): ComponentRate | null {
  const usable = componentUsableRows(rows, pick); // already chronological
  // Seed from OLS on the first ~4 usable bills (POC _init_ols head(max(4,3))).
  const init = fitComponentRate(usable.slice(0, Math.max(KALMAN_INIT_BILLS, 3)), pick);
  if (init == null) return null;
  // Too short for the filter: fall back to the initial OLS, as the POC does.
  if (usable.length < KALMAN_INIT_BILLS) return init;

  const f0 = init.fixedPerDay;
  const r0 = init.rate;
  const amounts = usable.map((r) => r[pick.comp] as number);
  const meanAmt = Math.max(5, amounts.reduce((a, b) => a + b, 0) / amounts.length);
  const R = (rFrac * meanAmt) ** 2; // observation variance ($²)
  // Per-step process drift as a fraction of each state's magnitude.
  const qf = (qFrac * Math.max(0.1, Math.abs(f0))) ** 2;
  const qr = (qFrac * Math.max(1e-3, Math.abs(r0))) ** 2;

  // F = I (random walk), Q = diag(qf, qr).
  let x: Vec2 = [f0, r0];
  let P: Mat2 = [
    [(0.5 * Math.max(0.1, Math.abs(f0))) ** 2 * 4, 0],
    [0, (0.5 * Math.max(1e-3, Math.abs(r0))) ** 2 * 4],
  ];

  for (const row of usable) {
    const d = row.days as number;
    const u = row[pick.usage] as number;
    const z = row[pick.comp] as number;

    // Predict: x = F·x (identity), P = F·P·Fᵀ + Q = P + Q.
    P = [
      [P[0][0] + qf, P[0][1]],
      [P[1][0], P[1][1] + qr],
    ];
    // Update with H = [d, u], scalar measurement z.
    // S = H·P·Hᵀ + R.
    const PHt: Vec2 = [P[0][0] * d + P[0][1] * u, P[1][0] * d + P[1][1] * u];
    const S = d * PHt[0] + u * PHt[1] + R;
    // K = P·Hᵀ / S.
    const K: Vec2 = [PHt[0] / S, PHt[1] / S];
    // Innovation y = z − H·x.
    const innov = z - (d * x[0] + u * x[1]);
    x = [x[0] + K[0] * innov, x[1] + K[1] * innov];
    // P = (I − K·H)·P.
    const a = 1 - K[0] * d;
    const b = -K[0] * u;
    const c = -K[1] * d;
    const e = 1 - K[1] * u;
    P = [
      [a * P[0][0] + b * P[1][0], a * P[0][1] + b * P[1][1]],
      [c * P[0][0] + e * P[1][0], c * P[0][1] + e * P[1][1]],
    ];
  }

  // One final predict step for the NEXT period (x_pred = F·x = x, since F = I),
  // clamped ≥ 0.
  return { fixedPerDay: Math.max(0, x[0]), rate: Math.max(0, x[1]) };
}

// Project per-fuel usage for a target window from the #44 degree-day fit, applied
// to the window's degree-days. Returns null when the fuel's fit is unusable.
function projectUsageForWindow(
  fit: UsageFit,
  target: ExpectedDegreeDays
): number | null {
  if (!fit.ok) return null;
  return Math.max(0, fit.base + fit.slopeC * target.cdd + fit.slopeH * target.hdd);
}

// The seasonal bill for a target window: weather-aware usage × per-component
// Kalman-filtered fixed/day + variable rates, summed over the four components.
// Returns null when usage can't be projected for either fuel or any component
// rate can't be estimated. PURE.
function rawSeasonalBill(
  trainRows: MonthRow[],
  target: ExpectedDegreeDays,
  targetDays: number
): number | null {
  const fits = fitUsageVsDegreeDays(trainRows);
  const kwh = projectUsageForWindow(fits.elec, target);
  const therms = projectUsageForWindow(fits.gas, target);
  if (kwh == null || therms == null) return null;

  let total = 0;
  for (const pick of COMPONENT_PICKS) {
    const cr = kalmanComponentRate(trainRows, pick);
    if (cr == null) return null;
    const usageVal = pick.usage === 'kwh' ? kwh : therms;
    total += cr.fixedPerDay * targetDays + cr.rate * usageVal;
  }
  return total;
}

// A bill row is "usable" for the seasonal model when it carries everything the
// raw model needs to be back-tested against: the four cost components, both
// usages, degree-days, a period length, and the actual cost (currentCharges).
function isSeasonalUsable(r: MonthRow): boolean {
  return (
    r.kwh != null &&
    r.therms != null &&
    r.hdd != null &&
    r.cdd != null &&
    r.days != null &&
    r.days > 0 &&
    r.billTotal != null &&
    r.elecSupply != null &&
    r.elecDelivery != null &&
    r.gasSupply != null &&
    r.gasDelivery != null
  );
}

export interface SeasonalEstimateOpts {
  // Expected degree-days for the predicted next-bill window (forecast + normals,
  // assembled impurely by the caller). Without it the weather-aware projection
  // can't run and the estimate returns null (caller falls back to #9).
  target?: ExpectedDegreeDays;
  // Length of the predicted next-bill window in days. Defaults to the median
  // statement interval the caller already knows (~30 when unknown).
  targetDays?: number;
  bandStdevs?: number; // k: band half-width in stdevs of the residuals (default 1)
}

// Walk-forward residuals (actual − model trained only on prior bills), in the
// usable bills' chronological order. Each residual prices the bill from its OWN
// actual period degree-days/days (already on the row). Returns the residual list;
// the caller takes its stdev to size the band. PURE.
export function trailingResiduals(rows: MonthRow[]): number[] {
  const usable = rows.filter(isSeasonalUsable);
  const residuals: number[] = [];
  for (let i = MIN_SEASONAL_BILLS; i < usable.length; i++) {
    const tg = usable[i];
    const raw = rawSeasonalBill(
      usable.slice(0, i),
      { hdd: tg.hdd as number, cdd: tg.cdd as number, forecastDays: 0, normalDays: tg.days as number },
      tg.days as number
    );
    if (raw == null) continue;
    residuals.push((tg.billTotal as number) - raw);
  }
  return residuals;
}

// The #67 seasonal next-bill estimate: weather-normal usage × per-component
// Kalman-filtered fixed+variable rates. Same { point, low, high, basis } shape
// as estimateNextBill. Returns null when there isn't enough data or no
// target-window degree-days were supplied — the caller then falls back to
// estimateNextBill (#9). PURE.
export function estimateNextBillSeasonal(
  rows: MonthRow[],
  opts?: SeasonalEstimateOpts
): NextBillEstimate | null {
  const k = opts?.bandStdevs ?? DEFAULT_BAND_STDEVS;
  const target = opts?.target;
  if (!target) return null; // no weather-aware window -> #9 fallback

  const usable = rows.filter(isSeasonalUsable);
  if (usable.length < MIN_SEASONAL_BILLS) return null;

  const targetDays = opts?.targetDays ?? Math.round(predictNextBill(
    usable.map((r) => new Date(Date.UTC(Math.floor(r.ym / 100), (r.ym % 100) - 1, 1)))
  ).medianDays);

  // Point estimate: model trained on ALL usable bills. The Kalman filter yields
  // ≈0 bias on its own, so there is no bias correction to add (FINDINGS).
  const point = rawSeasonalBill(usable, target, targetDays);
  if (point == null) return null;

  // Band from the spread of the walk-forward residuals (±k·σ); fall back to the
  // spread of recent period costs, then ±15% — the same ladder #9 uses.
  let half: number;
  let bandNote: string;
  const residuals = trailingResiduals(rows);
  const residStdev = sampleStdev(residuals);
  if (residStdev != null) {
    half = k * residStdev;
    bandNote = `±${k}σ of back-test residuals`;
  } else {
    const recentCosts = rows
      .filter((r) => r.billTotal != null)
      .slice(-DEFAULT_TRAILING)
      .map((r) => r.billTotal as number);
    const costStdev = sampleStdev(recentCosts);
    if (costStdev != null) {
      half = k * costStdev;
      bandNote = `±${k}σ of recent costs`;
    } else {
      half = DEFAULT_BAND_PCT * point;
      bandNote = `±${Math.round(DEFAULT_BAND_PCT * 100)}%`;
    }
  }

  const low = Math.max(0, point - half);
  const high = point + half;
  const basis = `weather-normal usage; per-component Kalman-filtered fixed+variable rates; ${bandNote}`;

  return { point, low, high, basis };
}
