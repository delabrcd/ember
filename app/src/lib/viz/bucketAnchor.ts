// PURE reference for the interval-history bucket aggregation's TRAILING-EDGE anchor
// (WS9 Fix 2). This is the executable spec of what getIntervalAggregated does in SQL:
// given the per-UTC-hour RECONCILED values for a window, fold them into bucketSecs
// buckets, SUM the energy per bucket, and ANCHOR each bucket's plotted point at the
// LATEST reading that fell into it — NOT at the bucket's start.
//
// WHY (the bug it fixes): the old SQL timestamped each aggregated point at its bucket
// START (floor(epoch/bucket)*bucket). At a coarse grain the CURRENT partial bucket
// spans [bucket-start … now], so a weekly bucket covering 06-18..now plotted at 06-18
// — the line appeared to end days before the latest reading, and recent data only
// surfaced after zooming to a finer grain. Anchoring at the latest reading makes the
// line's trailing edge reach the freshest data at EVERY grain. The bucket VALUE is the
// unchanged SUM; only the point's x-position moves.
//
// The production path runs this arithmetic IN POSTGRES (queries.ts
// getIntervalAggregated) so only ≤ MAX_POINTS rows cross the wire — this module is the
// hermetic, hand-calc-tested MIRROR of that SQL (test/bucketAnchor.test.ts). Keep the
// two in lockstep: a change to the bucketing/anchor rule belongs in BOTH. NO React /
// DOM / DB / fetch dependency.

// One reconciled hourly value (the `hourly` CTE's per-hour output): the UTC hour
// start, the SUM/representative quantity for that hour, the latest raw reading start
// that fell into the hour (so a bucket can anchor on the freshest of its hours), and
// the unit. `hourStartMs`/`latestStartMs` are epoch-ms.
export type ReconciledHour = {
  hourStartMs: number;
  latestStartMs: number;
  quantity: number;
  unit?: string;
};

// One aggregated bucket point — mirrors getIntervalAggregated's row shape: the point's
// instant is the LATEST reading in the bucket (epoch-ms), the quantity is the bucket
// SUM, intervalSeconds is the bucket width. Ascending by point instant.
export type AnchoredBucket = {
  pointStartMs: number;
  quantity: number;
  intervalSeconds: number;
  unit: string;
};

// Fold reconciled hourly values into bucketSecs-wide buckets (epoch-floor tiling on
// the hour start), SUM each bucket's quantity, and anchor the point at the MAX
// latestStartMs of the hours in the bucket. Mirrors the SQL's
// `GROUP BY floor(epoch(hour_start)/bucket)`, `sum(hour_quantity)`,
// `max(latest_start)`, `ORDER BY pointStart ASC`. PURE.
export function aggregateAnchoredBuckets(
  hourly: ReconciledHour[],
  bucketSecs: number
): AnchoredBucket[] {
  const bucket = Math.max(3600, Math.floor(bucketSecs));
  // Group by the epoch-floor bucket key of the HOUR start (the tiling key the SQL uses).
  const byBucket = new Map<
    number,
    { sum: number; latest: number; unit: string }
  >();
  for (const h of hourly) {
    if (!Number.isFinite(h.hourStartMs) || !Number.isFinite(h.quantity)) continue;
    const key = Math.floor(h.hourStartMs / 1000 / bucket); // floor(epoch_secs / bucket)
    const prev = byBucket.get(key);
    if (prev) {
      prev.sum += h.quantity;
      if (h.latestStartMs > prev.latest) prev.latest = h.latestStartMs;
      // MIN(unit) tiebreak isn't meaningful (one unit per fuel); first non-empty wins.
      if (!prev.unit && h.unit) prev.unit = h.unit;
    } else {
      byBucket.set(key, { sum: h.quantity, latest: h.latestStartMs, unit: h.unit ?? '' });
    }
  }
  return [...byBucket.values()]
    .map((b) => ({
      pointStartMs: b.latest,
      quantity: b.sum,
      intervalSeconds: bucket,
      unit: b.unit,
    }))
    .sort((a, b) => a.pointStartMs - b.pointStartMs);
}
