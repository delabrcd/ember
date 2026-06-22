// Usage/cost anomaly detection, weather-normalized (issue #45).
//
// "Is this bill weird, or was it just a cold month?" A merely-cold month uses
// more energy but its weather-NORMALIZED intensity (kWh per degree-day, therms
// per HDD — already computed in series.ts) stays put; a genuine efficiency
// regression (a leaky furnace, a failing fridge, a new always-on load) shows up
// as the intensity jumping above its own recent history. We flag that, and
// separately flag an all-in $/unit RATE jump (which catches a supply-rate / ESCO
// change the intensity check can't see).
//
// Everything here is PURE (no DB / network / React): the dashboard's getOverview
// feeds it the already-built MonthRow series and surfaces the typed flags as a
// subtle callout; the scheduled-scrape path optionally turns a flag on a NEW bill
// into a notification. The arithmetic is hand-calculated in anomaly.test.ts.
//
// ROBUST THRESHOLDING (mirrors prediction.ts' intervalSpreadDays). We compare the
// latest period's value against the TRAILING distribution of the same quantity
// using the median and the Median Absolute Deviation (MAD), not the mean/stdev:
// a single off month (or the spike we're trying to catch) can't inflate the
// baseline the way a stdev would. A value is anomalous when it sits more than
// THRESHOLD_K robust deviations from the trailing median:
//   |latest − median(trailing)| > THRESHOLD_K · (MAD_SCALE · MAD(trailing))
// MAD_SCALE = 1.4826 rescales the MAD to a stdev-equivalent for a normal
// distribution, so THRESHOLD_K reads like a "sigma" multiple. When the trailing
// MAD is zero (a perfectly flat history) we fall back to a relative band
// (FLAT_REL_BAND) so a hard-flat series still trips on a real jump rather than on
// any deviation at all.
//
// No new cost math: intensities (kwhPerDegreeDay/thermsPerHdd) and all-in rates
// (elecRateAllIn/gasRateAllIn) are read straight off the MonthRow — themselves
// derived from currentCharges/PDF-sourced numbers in series.ts. This module never
// touches totalDueAmount and never feeds /api/verify.

import type { MonthRow } from './chartSpec';
import { mad, median } from './stats';

// ---------------------------------------------------------------------------
// Documented constants (style mirrors prediction.ts).
//
//   THRESHOLD_K   = 3.5  how many robust (MAD-scaled) deviations from the
//                         trailing median a value must exceed to flag. 3.5 keeps
//                         normal month-to-month wobble quiet while still catching
//                         a genuine ~25%+ regression; it's deliberately
//                         conservative because a false alarm erodes trust.
//   MAD_SCALE     = 1.4826  the standard MAD→stdev consistency factor for a
//                         normal distribution (1 / Φ⁻¹(0.75)), so a deviation in
//                         these units is comparable to a stdev and THRESHOLD_K
//                         reads like a sigma multiple.
//   MIN_TRAILING  = 4    minimum trailing observations before we trust a baseline
//                         enough to flag against it. Below this the distribution
//                         is too thin to call anything an outlier.
//   FLAT_REL_BAND = 0.20  fallback band (±20% of the trailing median) used only
//                         when the trailing MAD is exactly 0 (a perfectly flat
//                         history), so a hard-flat series still flags a real jump
//                         instead of flagging ANY change.
// ---------------------------------------------------------------------------
export const THRESHOLD_K = 3.5;
export const MAD_SCALE = 1.4826;
export const MIN_TRAILING = 4;
export const FLAT_REL_BAND = 0.2;

export type AnomalyFuel = 'elec' | 'gas';
export type AnomalyMetric = 'usage' | 'rate';
export type AnomalyDirection = 'above' | 'below';

// One flagged deviation. `pct` is the signed fractional deviation from the
// trailing median (0.28 = 28% above); `deviations` is how many robust
// (MAD-scaled) units out it sits, for an honest "how surprising" read.
export interface AnomalyFlag {
  fuel: AnomalyFuel;
  metric: AnomalyMetric; // 'usage' = weather-normalized intensity; 'rate' = all-in $/unit
  direction: AnomalyDirection;
  ym: number; // the flagged (latest) period
  latest: number; // the latest value (intensity or $/unit)
  median: number; // trailing median it was compared against
  pct: number; // (latest − median) / median, signed
  deviations: number; // |latest − median| / (MAD_SCALE · MAD), or Infinity on a flat-MAD trip
  // Human-readable, e.g. "electric usage ~28% above weather-normalized
  // expectation". Built here (pure) so the UI and the notification share wording.
  message: string;
}

export interface AnomalyResult {
  flags: AnomalyFlag[];
  // The period the flags pertain to (the latest period that had any usable
  // metric), or null when nothing could be evaluated. Lets the notify path use a
  // stable per-bill dedupe key.
  ym: number | null;
}

export interface AnomalyOpts {
  thresholdK?: number; // override THRESHOLD_K
  minTrailing?: number; // override MIN_TRAILING
}

// Pull the per-row value for a (fuel, metric): the weather-normalized intensity
// for 'usage', the all-in $/unit for 'rate'. Both are already on the MonthRow,
// currentCharges-derived for the rate (series.ts), never totalDueAmount.
function valueOf(r: MonthRow, fuel: AnomalyFuel, metric: AnomalyMetric): number | null {
  if (metric === 'usage') return fuel === 'elec' ? r.kwhPerDegreeDay ?? null : r.thermsPerHdd ?? null;
  return fuel === 'elec' ? r.elecRateAllIn ?? null : r.gasRateAllIn ?? null;
}

// Friendly label parts for the message.
const FUEL_LABEL: Record<AnomalyFuel, string> = { elec: 'electric', gas: 'gas' };
const METRIC_LABEL: Record<AnomalyMetric, string> = {
  usage: 'usage', // qualified as "weather-normalized expectation" in the message
  rate: 'rate',
};

// Evaluate ONE (fuel, metric): take every row carrying that value in order, treat
// the LAST as the candidate and everything before it as the trailing baseline,
// and flag when the candidate is more than thresholdK robust deviations from the
// trailing median. Returns null when there isn't enough trailing history or the
// candidate is within band.
function evalSeries(
  rows: MonthRow[],
  fuel: AnomalyFuel,
  metric: AnomalyMetric,
  thresholdK: number,
  minTrailing: number
): AnomalyFlag | null {
  const points: { ym: number; v: number }[] = [];
  for (const r of rows) {
    const v = valueOf(r, fuel, metric);
    if (v != null && Number.isFinite(v)) points.push({ ym: r.ym, v });
  }
  if (points.length < minTrailing + 1) return null; // need a baseline + the candidate

  const candidate = points[points.length - 1];
  const trailing = points.slice(0, -1).map((p) => p.v);
  const med = median(trailing);
  if (!(med > 0)) return null; // a non-positive baseline median isn't a meaningful base

  const robust = MAD_SCALE * mad(trailing);
  const diff = candidate.v - med;
  const absDiff = Math.abs(diff);

  // Threshold: robust band when MAD>0, else a relative fallback band so a flat
  // history still flags a real jump (deviations reported as Infinity then).
  let isAnomaly: boolean;
  let deviations: number;
  if (robust > 0) {
    deviations = absDiff / robust;
    isAnomaly = deviations > thresholdK;
  } else {
    deviations = Number.POSITIVE_INFINITY;
    isAnomaly = absDiff > FLAT_REL_BAND * med;
  }
  if (!isAnomaly) return null;

  const direction: AnomalyDirection = diff > 0 ? 'above' : 'below';
  const pct = diff / med;
  const pctTxt = `${Math.round(Math.abs(pct) * 100)}%`;
  // User-facing wording: usage is compared after adjusting for the weather, so an
  // "above" can't be blamed on a hot/cold month; rate is the all-in price.
  const directionWord = direction === 'above' ? 'higher' : 'lower';
  const comparison =
    metric === 'usage' ? 'than usual for this weather' : 'than usual';
  const message = `${FUEL_LABEL[fuel]} ${METRIC_LABEL[metric]} ~${pctTxt} ${directionWord} ${comparison}`;

  return {
    fuel,
    metric,
    direction,
    ym: candidate.ym,
    latest: candidate.v,
    median: med,
    pct,
    deviations,
    message,
  };
}

const FUELS: AnomalyFuel[] = ['elec', 'gas'];
const METRICS: AnomalyMetric[] = ['usage', 'rate'];

// Detect usage/cost anomalies on the monthly series. For each fuel and each metric
// (weather-normalized intensity, all-in $/unit) compares the latest period to the
// robust trailing baseline and returns one flag per tripped combination. PURE:
// the caller (getOverview) supplies the already-built series and surfaces the
// flags; the scheduled-scrape path optionally notifies on a flag for a new bill.
export function detectAnomalies(rows: MonthRow[], opts?: AnomalyOpts): AnomalyResult {
  const thresholdK = opts?.thresholdK ?? THRESHOLD_K;
  const minTrailing = opts?.minTrailing ?? MIN_TRAILING;

  const flags: AnomalyFlag[] = [];
  for (const fuel of FUELS) {
    for (const metric of METRICS) {
      const f = evalSeries(rows, fuel, metric, thresholdK, minTrailing);
      if (f) flags.push(f);
    }
  }
  // The period the flags pertain to: the latest flagged ym, or (when nothing
  // flagged) the latest row carrying ANY of the four metrics, so the caller still
  // has a stable reference period. null when nothing is evaluable at all.
  let ym: number | null = flags.length ? Math.max(...flags.map((f) => f.ym)) : null;
  if (ym == null) {
    for (const r of rows) {
      if (FUELS.some((fu) => METRICS.some((m) => valueOf(r, fu, m) != null))) ym = r.ym;
    }
  }
  return { flags, ym };
}
