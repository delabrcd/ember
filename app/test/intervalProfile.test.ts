import { describe, expect, it } from 'vitest';
import { averageDayProfile, type IntervalProfileRow } from '../src/lib/intervalProfile';

// Hand-calculated tests for the PURE average-day profile shaper (issue #76).
// All instants are written as ISO strings WITH an explicit offset so the UTC
// instant is unambiguous; the shaper buckets them by LOCAL time-of-day in
// America/New_York (the default tz), which in June is EDT (-04:00).

const TZ = 'America/New_York';

describe('averageDayProfile (hand-calculated)', () => {
  it('averages four 15-min electric reads in the same local hour into one bucket', () => {
    // 13:00, 13:15, 13:30, 13:45 local (EDT) → all in the 13:00 hour bucket.
    const rows: IntervalProfileRow[] = [
      { intervalStart: '2026-06-08T13:00:00-04:00', intervalSeconds: 900, quantity: 0.2 },
      { intervalStart: '2026-06-08T13:15:00-04:00', intervalSeconds: 900, quantity: 0.4 },
      { intervalStart: '2026-06-08T13:30:00-04:00', intervalSeconds: 900, quantity: 0.6 },
      { intervalStart: '2026-06-08T13:45:00-04:00', intervalSeconds: 900, quantity: 0.8 },
    ];
    const out = averageDayProfile(rows, { tz: TZ });
    expect(out).toHaveLength(1);
    const b = out[0];
    expect(b.label).toBe('13:00');
    expect(b.minutes).toBe(13 * 60);
    expect(b.count).toBe(4);
    // mean = (0.2 + 0.4 + 0.6 + 0.8) / 4 = 0.5
    expect(b.mean).toBeCloseTo(0.5, 10);
    expect(b.min).toBeCloseTo(0.2, 10);
    expect(b.max).toBeCloseTo(0.8, 10);
  });

  it('produces two buckets in time order for reads spanning two local hours', () => {
    const rows: IntervalProfileRow[] = [
      // 08:00 hour
      { intervalStart: '2026-06-08T08:00:00-04:00', intervalSeconds: 900, quantity: 1 },
      { intervalStart: '2026-06-08T08:30:00-04:00', intervalSeconds: 900, quantity: 3 },
      // 09:00 hour
      { intervalStart: '2026-06-08T09:15:00-04:00', intervalSeconds: 900, quantity: 5 },
    ];
    const out = averageDayProfile(rows, { tz: TZ });
    expect(out.map((b) => b.label)).toEqual(['08:00', '09:00']);
    // 08:00 bucket: mean (1+3)/2 = 2, min 1, max 3, count 2
    expect(out[0]).toMatchObject({ minutes: 480, mean: 2, min: 1, max: 3, count: 2 });
    // 09:00 bucket: single read
    expect(out[1]).toMatchObject({ minutes: 540, mean: 5, min: 5, max: 5, count: 1 });
  });

  it('buckets a UTC instant that crosses the local-day boundary into the right local hour', () => {
    // 03:30 UTC on 2026-06-09 is 23:30 LOCAL on 2026-06-08 (EDT, -04:00) → hour 23.
    const rows: IntervalProfileRow[] = [
      { intervalStart: new Date('2026-06-09T03:30:00.000Z'), intervalSeconds: 900, quantity: 1.5 },
    ];
    const out = averageDayProfile(rows, { tz: TZ });
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe('23:00');
    expect(out[0].minutes).toBe(23 * 60);
    expect(out[0].mean).toBeCloseTo(1.5, 10);
  });

  it('aggregates the SAME local hour across different days into one bucket', () => {
    // Two different calendar days, both at the local 07:00 hour → one bucket, count 2.
    const rows: IntervalProfileRow[] = [
      { intervalStart: '2026-06-08T07:00:00-04:00', intervalSeconds: 3600, quantity: 2 },
      { intervalStart: '2026-06-09T07:00:00-04:00', intervalSeconds: 3600, quantity: 4 },
    ];
    const out = averageDayProfile(rows, { tz: TZ });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: '07:00', count: 2, mean: 3, min: 2, max: 4 });
  });

  it('honours a sub-hour bucketMinutes with HH:MM labels', () => {
    const rows: IntervalProfileRow[] = [
      { intervalStart: '2026-06-08T13:00:00-04:00', intervalSeconds: 900, quantity: 1 },
      { intervalStart: '2026-06-08T13:15:00-04:00', intervalSeconds: 900, quantity: 2 },
    ];
    const out = averageDayProfile(rows, { tz: TZ, bucketMinutes: 15 });
    // 13:00 and 13:15 fall in SEPARATE 15-min buckets.
    expect(out.map((b) => b.label)).toEqual(['13:00', '13:15']);
    expect(out[0]).toMatchObject({ minutes: 780, mean: 1, count: 1 });
    expect(out[1]).toMatchObject({ minutes: 795, mean: 2, count: 1 });
  });

  it('drops non-finite quantities and keeps the rest', () => {
    const rows: IntervalProfileRow[] = [
      { intervalStart: '2026-06-08T10:00:00-04:00', intervalSeconds: 3600, quantity: Number.NaN },
      { intervalStart: '2026-06-08T10:30:00-04:00', intervalSeconds: 3600, quantity: 7 },
    ];
    const out = averageDayProfile(rows, { tz: TZ });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: '10:00', count: 1, mean: 7 });
  });

  it('returns [] for empty input', () => {
    expect(averageDayProfile([], { tz: TZ })).toEqual([]);
  });

  it('excludes the unsettled tail (reads at/after `before`) so lagged zeros do not bias the mean', () => {
    // Same local hour across two days: a settled real reading and an unsettled 0.
    const rows: IntervalProfileRow[] = [
      { intervalStart: '2026-06-05T14:00:00-04:00', intervalSeconds: 3600, quantity: 2 }, // settled
      { intervalStart: '2026-06-09T14:00:00-04:00', intervalSeconds: 3600, quantity: 0 }, // lagged 0
    ];
    // Without a cutoff the 0 drags the 14:00 mean to 1.
    expect(averageDayProfile(rows, { tz: TZ })[0]).toMatchObject({ label: '14:00', mean: 1, count: 2 });
    // With `before` set before the lagged read, only the real 2 counts.
    const before = new Date('2026-06-08T00:00:00Z');
    const out = averageDayProfile(rows, { tz: TZ, before });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ label: '14:00', mean: 2, count: 1 });
  });
});
