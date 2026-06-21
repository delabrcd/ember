// PURE bucket-width selector for the interval HISTORY feed (WS1 rework of #36).
// The "Usage history" widget shows ONE energy (kWh / therms) line per fuel and no
// longer carries a manual 1h/15m toggle — the SERVER picks how wide each plotted
// bucket is from the requested [from, to] window so the returned series always
// stays bounded (≤ MAX_POINTS points) AND each point is an honest SUM of the
// energy in its bucket (energy is additive: 4×15-min sum exactly to the 1h value,
// so we always COMBINE adjacent intervals — never subsample a representative
// point the way the old bucket-MEAN downsampler did).
//
// NO React / DOM / DB / fetch dependency, so this is hand-calc unit-tested in
// isolation (test/chooseBucket.test.ts) like the sibling pure shapers.

// The allowed bucket widths, in SECONDS, smallest → largest. Each is a clean
// multiple of the 15-min base grain so an epoch-floor bucketing tiles the axis
// without straddling a base interval:
//   900    = 15 min   (the finest grain the AMI feed ever produces)
//   3600   = 1 h
//   7200   = 2 h
//   10800  = 3 h
//   21600  = 6 h
//   43200  = 12 h
//   86400  = 1 day
//   604800 = 1 week
// The ladder is intentionally coarse-stepped past an hour: once a window is wide
// enough to need >1h buckets it's a multi-week-to-multi-year view where the trend
// SHAPE matters, not per-hour precision, so a handful of widths covers every span
// from a day to a decade while keeping the point count under the cap.
export const BUCKET_LADDER_SECONDS: readonly number[] = [
  900, // 15 min
  3600, // 1 h
  2 * 3600, // 2 h
  3 * 3600, // 3 h
  6 * 3600, // 6 h
  12 * 3600, // 12 h
  86400, // 1 day
  7 * 86400, // 1 week
];

// Choose the SMALLEST ladder width such that the window divides into ≤ maxPoints
// buckets — i.e. the finest resolution that still fits the point budget.
//
//   bucketSecs = the smallest s in BUCKET_LADDER_SECONDS with
//                ceil(spanSecs / s) ≤ maxPoints
//
// (ceil, not floor: a span of 1.5 buckets still needs 2 points to cover it, so we
// must round UP when checking the budget.) If even the coarsest ladder width
// can't get under the cap — an absurdly wide window — we fall back to that
// coarsest width (the SQL still bounds the row count by GROUPing on the bucket;
// see the route), which is the most-decimated honest option.
//
// `spanMs` is the window width in milliseconds (to − from). A non-positive or
// non-finite span (a zero/degenerate window) returns the finest width (900s):
// there's at most one bucket to emit, so resolution can't hurt. A non-positive
// maxPoints returns the coarsest width (the budget is effectively zero). PURE.
export function chooseBucket(spanMs: number, maxPoints: number): number {
  const ladder = BUCKET_LADDER_SECONDS;
  if (!Number.isFinite(spanMs) || spanMs <= 0) return ladder[0];
  if (!Number.isFinite(maxPoints) || maxPoints <= 0) return ladder[ladder.length - 1];

  const spanSecs = spanMs / 1000;
  for (const bucketSecs of ladder) {
    // ceil: a partially-filled final bucket still costs one point.
    const buckets = Math.ceil(spanSecs / bucketSecs);
    if (buckets <= maxPoints) return bucketSecs;
  }
  // Window wider than even 1-week buckets × maxPoints can cover → coarsest width.
  return ladder[ladder.length - 1];
}
