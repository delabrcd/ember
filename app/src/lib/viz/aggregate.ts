// Pure aggregation/encoding for the Phase C vizTypes (issue #95; RFC §3.2 +
// Decision 3, and the AGENTS.md "new viz aggregation … is pure + tested" rule).
//
// This module turns dataset ROWS + a typed ENCODING (chartSpec.ts) into the
// drawable shape a renderer consumes: scatter → `{x,y}[]`, heatmap → a grid of
// `{x,y,value}` cells with min/max for the color scale, profile → 24-ish buckets
// each with a central value (+ optional spread band). It is deliberately
// DEPENDENCY-FREE: no React, no DOM, no DB, no Recharts — just numbers — so it's
// hand-calc unit-tested (test/viz.test.ts) the same way series.ts / prediction.ts
// are. The renderers (lib/widgets/vizRenderers.tsx) only draw what these return.
//
// Naming the field to read is generic over the row type via a small accessor:
// the encoding holds a `keyof Row`, and we read it as a number, treating
// null/undefined/NaN as MISSING (dropped, never coerced to 0 — a 0 kWh hour is
// real data; a missing reading is not). This is the one subtle rule worth a
// reviewer's eye: every aggregator drops missing inputs rather than zero-filling.

import type {
  HeatmapEncoding,
  ProfileEncoding,
  ScatterEncoding,
} from '@/lib/chartSpec';

// Read `row[key]` as a finite number, or `null` if it's absent/non-finite.
// Generic over the row; the encoding's key (a `NumericKey<Row>`, i.e. a subset of
// `keyof Row`) guarantees the field exists, but the value may still be null
// (every MonthRow numeric is nullable) or non-numeric — treated as MISSING (not
// 0). This is the one subtle rule worth a reviewer's eye: drop, never zero-fill.
function numAt<Row>(row: Row, key: keyof Row): number | null {
  const v = row[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

// ---------------------------------------------------------------------------
// SCATTER — rows → (x, y) points. Drops any row where x OR y is missing/NaN, so
// a half-populated row never plots at the origin. `label` (if encoded) is
// carried through for the tooltip; it's read raw (it can be a string).
// ---------------------------------------------------------------------------
export interface ScatterPoint {
  x: number;
  y: number;
  label?: string;
}

export function scatterPoints<Row>(
  rows: readonly Row[],
  encoding: ScatterEncoding<Row>
): ScatterPoint[] {
  const out: ScatterPoint[] = [];
  for (const row of rows) {
    const x = numAt(row, encoding.x);
    const y = numAt(row, encoding.y);
    if (x == null || y == null) continue; // drop incomplete pairs
    const point: ScatterPoint = { x, y };
    if (encoding.label != null) {
      const raw = row[encoding.label];
      // A label is for display only — stringify whatever it is, but skip
      // null/undefined so the tooltip shows nothing rather than "null".
      if (raw != null) point.label = String(raw);
    }
    out.push(point);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HEATMAP — rows → a dense grid of cells. Rows are binned by the integer (x, y)
// values their `x`/`y` fields hold (e.g. hour-of-day × day index); the `value`
// field is averaged within each (x, y) bin (multiple rows can share a cell). The
// returned grid is the SORTED set of distinct x's × distinct y's actually
// present, plus `min`/`max` over the cell values so the renderer's color scale
// is data-driven (not a magic constant). Cells with no data are emitted with
// `value: null` so the grid stays rectangular and the renderer can draw an empty
// slot. Missing value readings are dropped before averaging (never zero-filled).
// ---------------------------------------------------------------------------
export interface HeatmapCell {
  x: number;
  y: number;
  value: number | null; // mean of the value field over rows in this bin; null if none
  count: number; // how many (non-missing) rows fell in this bin
}
export interface HeatmapGrid {
  xs: number[]; // sorted distinct x bins (columns)
  ys: number[]; // sorted distinct y bins (rows)
  cells: HeatmapCell[]; // length === xs.length * ys.length, row-major by y then x
  min: number; // min cell mean across populated cells (for the color scale)
  max: number; // max cell mean across populated cells
}

export function dayHourHeatmap<Row>(
  rows: readonly Row[],
  encoding: HeatmapEncoding<Row>
): HeatmapGrid {
  // Accumulate sum+count per (x,y) bin so we can average. A string "x|y" key
  // keeps the map total without nesting; the x/y are integers from the row.
  const acc = new Map<string, { x: number; y: number; sum: number; count: number }>();
  const xSet = new Set<number>();
  const ySet = new Set<number>();

  for (const row of rows) {
    const x = numAt(row, encoding.x);
    const y = numAt(row, encoding.y);
    const value = numAt(row, encoding.value);
    if (x == null || y == null || value == null) continue; // need all three
    xSet.add(x);
    ySet.add(y);
    const key = `${x}|${y}`;
    const bin = acc.get(key);
    if (bin) {
      bin.sum += value;
      bin.count += 1;
    } else {
      acc.set(key, { x, y, sum: value, count: 1 });
    }
  }

  const xs = [...xSet].sort((a, b) => a - b);
  const ys = [...ySet].sort((a, b) => a - b);

  // Emit a full rectangular grid (row-major: for each y, every x). Empty bins
  // become a null-valued cell so the renderer can render every slot uniformly.
  const cells: HeatmapCell[] = [];
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const y of ys) {
    for (const x of xs) {
      const bin = acc.get(`${x}|${y}`);
      if (bin && bin.count > 0) {
        const mean = bin.sum / bin.count;
        cells.push({ x, y, value: mean, count: bin.count });
        if (mean < min) min = mean;
        if (mean > max) max = mean;
      } else {
        cells.push({ x, y, value: null, count: 0 });
      }
    }
  }

  // If nothing populated, collapse the infinities to a sane 0..0 domain so the
  // renderer never divides by NaN building its scale.
  if (!Number.isFinite(min)) min = 0;
  if (!Number.isFinite(max)) max = 0;

  return { xs, ys, cells, min, max };
}

// Build a y-bin → display-label map from the encoding's optional `yLabelField`.
// PURE: scans rows once, first label per y bin wins. Returned as a plain object
// keyed by the (numeric) y bin so the renderer can look up a row's label without
// re-touching the rows. Empty when no `yLabelField` is encoded.
export function heatmapRowLabels<Row>(
  rows: readonly Row[],
  encoding: HeatmapEncoding<Row>
): Record<number, string> {
  const labels: Record<number, string> = {};
  if (encoding.yLabelField == null) return labels;
  for (const row of rows) {
    const y = numAt(row, encoding.y);
    if (y == null || labels[y] != null) continue;
    const raw = row[encoding.yLabelField];
    if (raw != null) labels[y] = String(raw);
  }
  return labels;
}

// Normalize a value to 0..1 within [min, max] for a color scale. A degenerate
// domain (min === max — e.g. one populated cell, or all-equal) maps everything
// to the MIDDLE (0.5) rather than 0 or NaN, so a flat heatmap reads as uniform
// mid-tone instead of all-cold or all-blank. Exposed (and tested) because the
// color-scale math is the part of the heatmap a reviewer should scrutinize.
export function colorScale01(value: number, min: number, max: number): number {
  if (!(max > min)) return 0.5;
  const t = (value - min) / (max - min);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

// ---------------------------------------------------------------------------
// PROFILE — rows → one bucket per distinct `bucket` value (e.g. hour-of-day),
// each carrying the central tendency (mean or median) of the `value` field over
// rows in that bucket, plus the population std-dev for an optional spread band.
// Buckets are returned SORTED by the bucket key and only for bucket values that
// actually occur (no synthetic zero hours). Missing values are dropped before
// aggregating; a bucket with zero non-missing values is omitted.
// ---------------------------------------------------------------------------
export interface ProfileBucket {
  bucket: number; // the period key (e.g. hour 0–23)
  value: number; // mean or median of the value field in this bucket
  count: number; // non-missing rows aggregated
  std: number; // population std-dev (for a ±1σ band); 0 when count < 2
  lower: number; // value − std (clamped at 0; usage can't go negative)
  upper: number; // value + std
}

function mean(xs: number[]): number {
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function median(xs: number[]): number {
  // Caller passes a non-empty array; sort a copy so we don't mutate input.
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Population std-dev (divide by N, not N−1): this is a descriptive spread of the
// observed hours, not an inferential estimate, so N is the right denominator.
function populationStd(xs: number[], mu: number): number {
  if (xs.length < 2) return 0;
  let acc = 0;
  for (const x of xs) acc += (x - mu) * (x - mu);
  return Math.sqrt(acc / xs.length);
}

export function hourOfDayProfile<Row>(
  rows: readonly Row[],
  encoding: ProfileEncoding<Row>
): ProfileBucket[] {
  const agg = encoding.agg ?? 'mean';
  // Group the (non-missing) value readings by bucket.
  const groups = new Map<number, number[]>();
  for (const row of rows) {
    const b = numAt(row, encoding.bucket);
    const v = numAt(row, encoding.value);
    if (b == null || v == null) continue;
    const arr = groups.get(b);
    if (arr) arr.push(v);
    else groups.set(b, [v]);
  }

  const buckets: ProfileBucket[] = [];
  for (const [bucket, values] of groups) {
    if (values.length === 0) continue;
    const mu = mean(values); // mean is needed for the std band regardless of agg
    const central = agg === 'median' ? median(values) : mu;
    const std = populationStd(values, mu);
    buckets.push({
      bucket,
      value: central,
      count: values.length,
      std,
      lower: Math.max(0, central - std),
      upper: central + std,
    });
  }

  buckets.sort((a, b) => a.bucket - b.bucket);
  return buckets;
}
