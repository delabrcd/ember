// PURE time-bucket downsampler for the interval HISTORY feed (issue #36). When a
// wide global range (e.g. "All" = 2+ years of hourly reads ≈ 17k rows) would
// otherwise dump tens of thousands of points onto the Recharts main thread, we
// bucket the rows into ≤ MAX_POINTS equal-width TIME buckets and emit ONE
// representative row per non-empty bucket (the bucket's MEAN quantity, carrying
// fuelType/unit/intervalSeconds from the bucket and the bucket's FIRST
// intervalStart). When the input already fits (rows.length ≤ maxPoints) it's
// returned as-is.
//
// DISPLAY ONLY: this is a visual decimation of the additive interval feed. It is
// NEVER fed to /api/verify, the monthly series, or any billed-cost number — those
// paths don't read interval rows at all. Losing the finest grain over a wide
// window is acceptable: 15-min electric only exists for ~the last 48h anyway, and
// the history chart's job is the shape of the trend, not per-read precision.
//
// NO React / DOM / DB / fetch dependency, so it's hand-calc unit-tested in
// isolation (test/downsampleInterval.test.ts) like the sibling pure shapers.

// The minimal row shape the downsampler reads + preserves. A strict superset is
// fine (extra fields are carried through verbatim from the bucket's first row).
export type DownsampleRow = {
  intervalStart: Date | string;
  intervalSeconds?: number;
  quantity: number;
  fuelType?: string;
  unit?: string;
};

// Default cap on the number of points the route returns (and the chart renders).
// ~600 keeps the payload small (a few tens of KB) and Recharts smooth on the main
// thread regardless of the selected range.
export const MAX_POINTS = 600;

// Parse a row's intervalStart (Date or ISO string) to epoch ms, or null if it's
// unparseable. PURE.
function toMs(start: Date | string): number | null {
  const t = start instanceof Date ? start.getTime() : new Date(start).getTime();
  return Number.isFinite(t) ? t : null;
}

// Downsample `rows` (assumed ascending by intervalStart, as queries.getIntervalSeries
// returns them) to at most `maxPoints` representative rows by equal-width TIME
// bucketing.
//
//   • rows.length ≤ maxPoints (or maxPoints ≤ 0)            → returned AS-IS.
//   • otherwise: span = [firstTs, lastTs] is divided into `maxPoints` equal
//     time-buckets; each row lands in bucket floor((ts - firstTs) / bucketMs);
//     each NON-EMPTY bucket emits ONE row:
//       - quantity   = MEAN of the bucket's quantities
//       - intervalStart, fuelType, unit, intervalSeconds = the bucket's FIRST row's
//       (carried verbatim — over a wide window the grain is uniform anyway)
//   • output stays ascending by intervalStart (buckets are visited low→high) and
//     has ≤ maxPoints rows (one per non-empty bucket; empty buckets are skipped,
//     never fabricated as zeros — gaps stay gaps).
//
// Rows with a non-finite quantity or unparseable intervalStart are dropped before
// bucketing (consistent with the other shapers). PURE.
export function downsampleByTime<T extends DownsampleRow>(rows: T[], maxPoints: number = MAX_POINTS): T[] {
  if (maxPoints <= 0 || rows.length <= maxPoints) return rows;

  // Keep only well-formed rows, remembering each one's timestamp.
  const clean: { row: T; ts: number }[] = [];
  for (const row of rows) {
    const q = Number(row.quantity);
    if (!Number.isFinite(q)) continue;
    const ts = toMs(row.intervalStart);
    if (ts == null) continue;
    clean.push({ row, ts });
  }
  if (clean.length <= maxPoints) return clean.map((c) => c.row);

  const firstTs = clean[0].ts;
  const lastTs = clean[clean.length - 1].ts;
  const span = lastTs - firstTs;
  // Degenerate span (all rows at the same instant) → average them into one row.
  if (span <= 0) {
    const mean = clean.reduce((acc, c) => acc + Number(c.row.quantity), 0) / clean.length;
    return [{ ...clean[0].row, quantity: mean }];
  }

  const bucketMs = span / maxPoints;
  // Accumulate per bucket index, preserving insertion order (low→high since input
  // is ascending) so the output stays chronological.
  type Acc = { first: T; sum: number; count: number };
  const buckets = new Map<number, Acc>();
  for (const { row, ts } of clean) {
    // Clamp the final-instant row (idx would be maxPoints) into the last bucket.
    const idx = Math.min(maxPoints - 1, Math.floor((ts - firstTs) / bucketMs));
    const acc = buckets.get(idx);
    if (acc) {
      acc.sum += Number(row.quantity);
      acc.count += 1;
    } else {
      buckets.set(idx, { first: row, sum: Number(row.quantity), count: 1 });
    }
  }

  const out: T[] = [];
  for (const idx of [...buckets.keys()].sort((a, b) => a - b)) {
    const acc = buckets.get(idx)!;
    out.push({ ...acc.first, quantity: acc.sum / acc.count });
  }
  return out;
}
