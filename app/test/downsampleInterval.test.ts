import { describe, expect, it } from 'vitest';
import { downsampleByTime, MAX_POINTS } from '../src/lib/viz/downsampleInterval';

// Hand-calculated unit tests for the PURE interval downsampler (issue #36). The
// downsampler decimates a wide interval feed to ≤ maxPoints representative rows
// by equal-width TIME bucketing, emitting the bucket-MEAN quantity and carrying
// the bucket's first row's other fields. DISPLAY-only — never a billed number.

const HOUR = 3_600_000;

// Build `n` hourly rows starting at a fixed epoch, quantity = its index (so the
// mean of any contiguous run is trivially hand-checkable).
function hourlyRows(n: number, startMs = Date.UTC(2024, 0, 1, 0, 0, 0)) {
  return Array.from({ length: n }, (_, i) => ({
    intervalStart: new Date(startMs + i * HOUR),
    intervalSeconds: 3600,
    quantity: i,
    fuelType: 'ELECTRIC',
    unit: 'kWh',
  }));
}

describe('downsampleByTime', () => {
  it('passes the rows through unchanged when length ≤ maxPoints', () => {
    const rows = hourlyRows(5);
    expect(downsampleByTime(rows, 10)).toBe(rows); // same reference — no copy
    expect(downsampleByTime(rows, 5)).toBe(rows); // exactly at the cap, still as-is
  });

  it('returns ≤ maxPoints rows for a large input', () => {
    const rows = hourlyRows(2000);
    const out = downsampleByTime(rows, 100);
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.length).toBeGreaterThan(0);
  });

  it('keeps the output in ascending intervalStart order', () => {
    const out = downsampleByTime(hourlyRows(1000), 50);
    for (let i = 1; i < out.length; i++) {
      const prev = (out[i - 1].intervalStart as Date).getTime();
      const cur = (out[i].intervalStart as Date).getTime();
      expect(cur).toBeGreaterThan(prev);
    }
  });

  it('emits the bucket MEAN, carrying the bucket first row fields', () => {
    // 8 rows, quantities 0..7, over a 7-hour span. maxPoints=2 → bucketMs = 7h/2 =
    // 3.5h. firstTs = hour 0.
    //   bucket 0: floor((ts-first)/3.5h) === 0 for hours 0,1,2,3 (3h/3.5h=0.857)
    //             → quantities [0,1,2,3], mean = 6/4 = 1.5, first = hour 0.
    //   bucket 1: hours 4,5,6 (4h/3.5h=1.14→1, 6h/3.5h=1.71→1) plus the final
    //             hour 7 is clamped into the last bucket (idx maxPoints-1 = 1).
    //             → quantities [4,5,6,7], mean = 22/4 = 5.5, first = hour 4.
    const out = downsampleByTime(hourlyRows(8), 2);
    expect(out.length).toBe(2);
    expect(out[0].quantity).toBeCloseTo(1.5, 10);
    expect((out[0].intervalStart as Date).getTime()).toBe(Date.UTC(2024, 0, 1, 0));
    expect(out[0].fuelType).toBe('ELECTRIC');
    expect(out[0].unit).toBe('kWh');
    expect(out[1].quantity).toBeCloseTo(5.5, 10);
    expect((out[1].intervalStart as Date).getTime()).toBe(Date.UTC(2024, 0, 1, 4));
  });

  it('skips empty buckets (gaps stay gaps, never fabricated as zeros)', () => {
    // Two tight clusters far apart: rows at hours 0,1 and hours 100,101. With many
    // buckets the middle buckets are empty and must NOT appear in the output.
    const startMs = Date.UTC(2024, 0, 1, 0);
    const rows = [0, 1, 100, 101].map((h) => ({
      intervalStart: new Date(startMs + h * HOUR),
      intervalSeconds: 3600,
      quantity: 1,
      fuelType: 'ELECTRIC',
      unit: 'kWh',
    }));
    const out = downsampleByTime(rows, 102); // more buckets than rows → still bucketed
    // Only the 4 populated rows survive; the ~98 empty buckets are dropped.
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out.every((r) => Number.isFinite(r.quantity))).toBe(true);
  });

  it('drops rows with a non-finite quantity or unparseable timestamp before bucketing', () => {
    const startMs = Date.UTC(2024, 0, 1, 0);
    const rows = [
      { intervalStart: new Date(startMs), intervalSeconds: 3600, quantity: 2 },
      { intervalStart: new Date(startMs + HOUR), intervalSeconds: 3600, quantity: NaN },
      { intervalStart: 'not-a-date', intervalSeconds: 3600, quantity: 5 },
      { intervalStart: new Date(startMs + 2 * HOUR), intervalSeconds: 3600, quantity: 4 },
    ];
    // maxPoints=1 forces all surviving rows into one bucket → mean of the GOOD
    // quantities only: (2 + 4) / 2 = 3.
    const out = downsampleByTime(rows, 1);
    expect(out.length).toBe(1);
    expect(out[0].quantity).toBeCloseTo(3, 10);
  });

  it('collapses a zero-span input (all rows at one instant) to a single mean row', () => {
    const t = new Date(Date.UTC(2024, 0, 1, 0));
    const rows = [
      { intervalStart: t, intervalSeconds: 3600, quantity: 2 },
      { intervalStart: t, intervalSeconds: 3600, quantity: 4 },
      { intervalStart: t, intervalSeconds: 3600, quantity: 6 },
    ];
    const out = downsampleByTime(rows, 1);
    expect(out.length).toBe(1);
    expect(out[0].quantity).toBeCloseTo(4, 10); // (2+4+6)/3
  });

  it('worst case: ~2yr of hourly reads (~17k rows) downsamples to ≤ MAX_POINTS', () => {
    // 2 years ≈ 17,520 hourly rows. At the default MAX_POINTS the returned series
    // is bounded so the client renders a smooth chart for the "All" range.
    const out = downsampleByTime(hourlyRows(17_520));
    expect(out.length).toBeLessThanOrEqual(MAX_POINTS);
    expect(MAX_POINTS).toBe(600);
  });

  it('handles maxPoints ≤ 0 by returning the rows untouched', () => {
    const rows = hourlyRows(50);
    expect(downsampleByTime(rows, 0)).toBe(rows);
    expect(downsampleByTime(rows, -5)).toBe(rows);
  });
});
