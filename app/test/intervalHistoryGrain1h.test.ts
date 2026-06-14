import { describe, expect, it } from 'vitest';
import { reconcileToHourly } from '../src/lib/intervalProfile';
import { downsampleByTime } from '../src/lib/viz/downsampleInterval';

// Regression test for the grain=1h history path (the "1h view caps at the moment
// 15-min data begins" bug). The fix is purely about ORDER OF OPERATIONS on the
// raw mixed-grain interval feed:
//
//   NEW (route ?grain=1h):  downsampleByTime(reconcileToHourly(raw))   — correct
//   OLD (default + client):  reconcileToHourly(downsampleByTime(raw))  — buggy
//
// reconcileToHourly's "partial 15-min slots + no hourly row in that hour → SKIP"
// rule is the trap: when downsampling runs FIRST it decimates the recent 15-min
// rows into lone (1-of-4) representatives, and reconcile then drops every one of
// them — capping the line right where 15-min recording started. Reconciling the
// RAW rows first (four complete slots → one hourly value) keeps the full timeline,
// and the subsequent downsample only thins an already-hourly series.

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 5, 1, 0, 0, 0); // 2026-06-01T00:00:00Z

// A realistic shape that mirrors prod: a long run of hourly (3600s) rows, then a
// recent stretch recorded ONLY as complete 15-min (900s) slots (4 per hour). The
// recent era is exactly what the old order dropped.
function mixedFeed(baseHours: number, recentHours: number) {
  const rows: {
    intervalStart: Date;
    intervalSeconds: number;
    quantity: number;
    fuelType: string;
  }[] = [];
  // Base era: one hourly row per hour, quantity 1.
  for (let h = 0; h < baseHours; h++) {
    rows.push({ intervalStart: new Date(BASE + h * HOUR), intervalSeconds: 3600, quantity: 1, fuelType: 'ELECTRIC' });
  }
  // Recent era: four 15-min slots per hour (each 0.25 → hourly sum 1), no hourly row.
  for (let h = baseHours; h < baseHours + recentHours; h++) {
    for (let q = 0; q < 4; q++) {
      rows.push({
        intervalStart: new Date(BASE + h * HOUR + q * 15 * 60_000),
        intervalSeconds: 900,
        quantity: 0.25,
        fuelType: 'ELECTRIC',
      });
    }
  }
  return rows;
}

// Hour-index (relative to BASE) of the last point in a series — i.e. how far to the
// right the chart's time axis reaches.
function lastHourIndex(rows: { intervalStart: Date | string }[]): number {
  const last = rows[rows.length - 1].intervalStart;
  const ms = last instanceof Date ? last.getTime() : new Date(last).getTime();
  return Math.round((ms - BASE) / HOUR);
}

describe('grain=1h: reconcile-then-downsample preserves the recent 15-min tail', () => {
  const BASE_HOURS = 20;
  const RECENT_HOURS = 4; // hours 20..23 are 15-min-only
  const MAX = 10; // force downsampling (raw has 20 + 16 = 36 rows)
  const recentStart = BASE_HOURS; // first hour of the 15-min-only era

  it('NEW order (route) reaches into the recent 15-min era', () => {
    const raw = mixedFeed(BASE_HOURS, RECENT_HOURS);
    const hourly = reconcileToHourly(raw); // 24 hourly rows (20 base + 4 summed-15m)
    expect(hourly).toHaveLength(BASE_HOURS + RECENT_HOURS);
    const out = downsampleByTime(hourly, MAX);
    expect(out.length).toBeLessThanOrEqual(MAX);
    // The right edge reaches the recent era — the bug is gone.
    expect(lastHourIndex(out)).toBeGreaterThanOrEqual(recentStart);
  });

  it('OLD order (downsample-then-reconcile) drops the recent era — the bug', () => {
    const raw = mixedFeed(BASE_HOURS, RECENT_HOURS);
    const decimated = downsampleByTime(raw, MAX);
    const hourly = reconcileToHourly(decimated);
    // The recent 15-min reps became lone slots and were skipped → the line caps
    // BEFORE the 15-min era ever starts.
    expect(lastHourIndex(hourly)).toBeLessThan(recentStart);
  });

  it('when the feed already fits the cap, both orders agree (no decimation)', () => {
    // Small feed (≤ cap): downsampleByTime is a pass-through, so the only operation
    // is reconcile — both orders reach the recent era identically.
    const raw = mixedFeed(4, 4); // 4 + 16 = 20 rows ≤ MAX*… use a generous cap
    const newOrder = downsampleByTime(reconcileToHourly(raw), 100);
    const oldOrder = reconcileToHourly(downsampleByTime(raw, 100));
    expect(lastHourIndex(newOrder)).toBe(lastHourIndex(oldOrder));
    expect(lastHourIndex(newOrder)).toBeGreaterThanOrEqual(4); // recent era present
  });
});
