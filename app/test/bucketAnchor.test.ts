import { describe, expect, it } from 'vitest';
import { aggregateAnchoredBuckets, type ReconciledHour } from '../src/lib/viz/bucketAnchor';

// Hand-calculated tests for the WS9 Fix-2 trailing-edge anchor (the pure MIRROR of
// getIntervalAggregated's SQL group/sum/max-anchor). The key property: an aggregated
// bucket's plotted point lands at the LATEST reading inside it, NOT the bucket START —
// so the line's trailing edge reaches the most recent data at every grain.

const HOUR = 3_600_000;
// A clean UTC week boundary: 2026-06-15T00:00:00Z is a Monday. floor(epoch/604800) for
// the whole week 06-15..06-21 shares one bucket key (the unix epoch's week buckets land
// on Thursdays, but the anchor property holds regardless of which calendar day the
// bucket starts — what matters is all hours in a window fold to one key here).
const WEEK_SECS = 7 * 86400;
const BASE = Date.UTC(2026, 5, 15, 0, 0, 0); // 2026-06-15T00:00:00Z (Mon)

describe('aggregateAnchoredBuckets (hand-calculated)', () => {
  it('anchors a partial trailing bucket at its LATEST reading, not the bucket start', () => {
    // Three hourly values inside the SAME weekly bucket. The bucket START is the
    // epoch-floored week boundary (far earlier); the LATEST hour read is at +50h.
    // Without WS9 the point would plot at the bucket start (the bug). With WS9 it
    // plots at the latest reading (+50h) — the trailing edge reaches the freshest data.
    const hourly: ReconciledHour[] = [
      { hourStartMs: BASE + 0 * HOUR, latestStartMs: BASE + 0 * HOUR, quantity: 1, unit: 'kWh' },
      { hourStartMs: BASE + 24 * HOUR, latestStartMs: BASE + 24 * HOUR, quantity: 2, unit: 'kWh' },
      { hourStartMs: BASE + 50 * HOUR, latestStartMs: BASE + 50 * HOUR, quantity: 3, unit: 'kWh' },
    ];

    const out = aggregateAnchoredBuckets(hourly, WEEK_SECS);

    // The bucket key floor(epoch/604800) is the same for all three hours? Check: they
    // span 50h = ~2.08 days, well under a 7-day bucket, but a floor boundary could fall
    // between them. Compute the expected number of buckets from the keys.
    const key = (ms: number) => Math.floor(ms / 1000 / WEEK_SECS);
    const keys = new Set(hourly.map((h) => key(h.hourStartMs)));
    expect(out).toHaveLength(keys.size);

    // Whatever the bucket split, the FINAL (trailing) bucket's point must equal the
    // latest reading among the hours that fell into it — never the bucket start.
    const last = out[out.length - 1];
    const lastKey = key(BASE + 50 * HOUR);
    const hoursInLast = hourly.filter((h) => key(h.hourStartMs) === lastKey);
    const expectedLatest = Math.max(...hoursInLast.map((h) => h.latestStartMs));
    const bucketStartMs = lastKey * WEEK_SECS * 1000;
    expect(last.pointStartMs).toBe(expectedLatest);
    expect(last.pointStartMs).toBeGreaterThan(bucketStartMs); // NOT pinned to the start
    // The value is the SUM of the hours in that bucket (unchanged by the anchor).
    expect(last.quantity).toBeCloseTo(
      hoursInLast.reduce((s, h) => s + h.quantity, 0),
      10
    );
    expect(last.intervalSeconds).toBe(WEEK_SECS);
    expect(last.unit).toBe('kWh');
  });

  it('sums all hours of a single bucket and anchors at the max latest reading', () => {
    // All three hours share ONE hourly grain bucket (3600s = 1h is too fine; use a
    // 3-hour bucket so 00:00, 01:00, 02:00 fold together). Sum = 5+7+11 = 23; anchor at
    // the latest reading (02:45 inside the 02:00 hour, latestStartMs = +2h45m).
    const THREE_H = 3 * 3600;
    const hourly: ReconciledHour[] = [
      { hourStartMs: BASE + 0 * HOUR, latestStartMs: BASE + 0 * HOUR, quantity: 5, unit: 'kWh' },
      { hourStartMs: BASE + 1 * HOUR, latestStartMs: BASE + 1 * HOUR, quantity: 7, unit: 'kWh' },
      // Latest hour's freshest raw slot is at +2h45m (a 15-min read), not the hour start.
      { hourStartMs: BASE + 2 * HOUR, latestStartMs: BASE + 2 * HOUR + 45 * 60_000, quantity: 11, unit: 'kWh' },
    ];

    const out = aggregateAnchoredBuckets(hourly, THREE_H);
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBeCloseTo(23, 10);
    expect(out[0].pointStartMs).toBe(BASE + 2 * HOUR + 45 * 60_000);
    expect(out[0].intervalSeconds).toBe(THREE_H);
  });

  it('keeps buckets in ascending point order and never double-counts', () => {
    const SIX_H = 6 * 3600;
    const hourly: ReconciledHour[] = [
      // bucket A (00:00–05:00): two hours, sum 1+2=3, latest +4h
      { hourStartMs: BASE + 0 * HOUR, latestStartMs: BASE + 0 * HOUR, quantity: 1 },
      { hourStartMs: BASE + 4 * HOUR, latestStartMs: BASE + 4 * HOUR, quantity: 2 },
      // bucket B (06:00–11:00): one hour, sum 4, latest +7h
      { hourStartMs: BASE + 7 * HOUR, latestStartMs: BASE + 7 * HOUR, quantity: 4 },
    ];
    const out = aggregateAnchoredBuckets(hourly, SIX_H);
    expect(out).toHaveLength(2);
    expect(out[0].pointStartMs).toBeLessThan(out[1].pointStartMs);
    expect(out[0].quantity).toBeCloseTo(3, 10); // 1+2, not re-counted
    expect(out[1].quantity).toBeCloseTo(4, 10);
    expect(out[0].pointStartMs).toBe(BASE + 4 * HOUR); // anchored at the latest of bucket A
  });
});
