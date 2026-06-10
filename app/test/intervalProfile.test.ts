import { describe, expect, it } from 'vitest';
import { averageDayProfile, reconcileToHourly, type IntervalProfileRow } from '../src/lib/intervalProfile';

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

// ---------------------------------------------------------------------------
// reconcileToHourly — hand-calculated tests (issue #121)
// ---------------------------------------------------------------------------
// All instants are written with an explicit UTC offset so the UTC instant is
// unambiguous. America/New_York in June is EDT (-04:00 = UTC-4), which is a
// whole-hour offset, so four 15-min slots within one local clock-hour map to
// exactly one UTC hour. All reconcileToHourly output rows have intervalSeconds=3600.

describe('reconcileToHourly (hand-calculated)', () => {
  // Helper to build a 15-min row with an optional fuelType.
  function row15(iso: string, quantity: number, fuelType = 'ELECTRIC'): IntervalProfileRow & { fuelType: string } {
    return { intervalStart: iso, intervalSeconds: 900, quantity, fuelType };
  }
  function row60(iso: string, quantity: number, fuelType = 'ELECTRIC'): IntervalProfileRow & { fuelType: string } {
    return { intervalStart: iso, intervalSeconds: 3600, quantity, fuelType };
  }

  it('four 15-min slots in one hour: SUM wins over the paired hourly row (no double-count)', () => {
    // 13:00–13:45 local EDT (UTC 17:00–17:45) + a paired hourly row of 0.9 for the same hour.
    const rows = [
      row15('2026-06-08T13:00:00-04:00', 0.05),
      row15('2026-06-08T13:15:00-04:00', 0.10),
      row15('2026-06-08T13:30:00-04:00', 0.15),
      row15('2026-06-08T13:45:00-04:00', 0.20),
      row60('2026-06-08T13:00:00-04:00', 0.9),
    ];
    const out = reconcileToHourly(rows);
    expect(out).toHaveLength(1);
    expect(out[0].intervalSeconds).toBe(3600);
    // 15-min SUM: 0.05 + 0.10 + 0.15 + 0.20 = 0.50 (NOT the hourly 0.9, NOT 0.5+0.9=1.4)
    expect(out[0].quantity).toBeCloseTo(0.5, 10);
  });

  it('only an hourly row: passes through unchanged', () => {
    const rows = [row60('2026-06-08T09:00:00-04:00', 1.23)];
    const out = reconcileToHourly(rows);
    expect(out).toHaveLength(1);
    expect(out[0].intervalSeconds).toBe(3600);
    expect(out[0].quantity).toBeCloseTo(1.23, 10);
  });

  it('three 15-min slots (partial) + paired hourly: hourly wins (15-min incomplete)', () => {
    const rows = [
      row15('2026-06-08T10:00:00-04:00', 0.2),
      row15('2026-06-08T10:15:00-04:00', 0.2),
      row15('2026-06-08T10:30:00-04:00', 0.2),
      // no 10:45 slot
      row60('2026-06-08T10:00:00-04:00', 0.85),
    ];
    const out = reconcileToHourly(rows);
    expect(out).toHaveLength(1);
    expect(out[0].intervalSeconds).toBe(3600);
    expect(out[0].quantity).toBeCloseTo(0.85, 10);
  });

  it('three 15-min slots, no hourly: hour is skipped (incomplete → would underreport)', () => {
    const rows = [
      row15('2026-06-08T11:00:00-04:00', 0.3),
      row15('2026-06-08T11:15:00-04:00', 0.3),
      row15('2026-06-08T11:30:00-04:00', 0.3),
      // no 11:45 slot, no hourly row
    ];
    const out = reconcileToHourly(rows);
    expect(out).toHaveLength(0);
  });

  it('two fuels do not cross-contaminate; rows come out sorted by intervalStart', () => {
    // ELECTRIC 13:00 hour (four 15-min) + GAS 13:00 hour (hourly) — same UTC instant,
    // different fuels. Each fuel resolves independently.
    const rows = [
      // GAS hourly first (out of order) to verify sort
      row60('2026-06-08T07:00:00-04:00', 0.5, 'GAS'),
      row15('2026-06-08T13:00:00-04:00', 0.1, 'ELECTRIC'),
      row15('2026-06-08T13:15:00-04:00', 0.1, 'ELECTRIC'),
      row15('2026-06-08T13:30:00-04:00', 0.1, 'ELECTRIC'),
      row15('2026-06-08T13:45:00-04:00', 0.1, 'ELECTRIC'),
    ];
    const out = reconcileToHourly(rows);
    expect(out).toHaveLength(2);

    // Sort check: GAS 07:00 UTC < ELECTRIC 17:00 UTC
    const gasRow = out.find((r) => r.fuelType === 'GAS');
    const elecRow = out.find((r) => r.fuelType === 'ELECTRIC');
    expect(gasRow).toBeDefined();
    expect(elecRow).toBeDefined();
    expect((gasRow!.intervalStart as Date).getTime()).toBeLessThan((elecRow!.intervalStart as Date).getTime());

    // GAS: hourly 0.5 passes through
    expect(gasRow!.quantity).toBeCloseTo(0.5, 10);
    // ELECTRIC: four 15-min slots SUM to 0.4
    expect(elecRow!.quantity).toBeCloseTo(0.4, 10);
    // No cross-contamination between fuels
    expect(gasRow!.quantity).not.toBeCloseTo(elecRow!.quantity, 5);
  });

  it('drops rows with non-finite quantity and still processes the rest', () => {
    const rows = [
      row15('2026-06-08T08:00:00-04:00', Number.NaN),
      row60('2026-06-08T08:00:00-04:00', 2.0),
    ];
    const out = reconcileToHourly(rows);
    // NaN 15-min slot is dropped; the hourly 2.0 survives (and wins since no 4 slots)
    expect(out).toHaveLength(1);
    expect(out[0].quantity).toBeCloseTo(2.0, 10);
  });

  it('returns [] for empty input', () => {
    expect(reconcileToHourly([])).toEqual([]);
  });

  it('end-to-end: averageDayProfile(reconcileToHourly(mixed)) gives correct per-hour means (no double-count)', () => {
    // Two calendar days, same 13:00 local hour. Day A has 4 15-min slots (sum 0.5) +
    // a paired hourly 0.9. Day B has only an hourly 0.6. After reconcile: Day A→0.5,
    // Day B→0.6. averageDayProfile should report mean = (0.5+0.6)/2 = 0.55.
    //
    // Without reconcile, feeding the raw mixed rows to averageDayProfile would give
    // count=6 and mean=(0.05+0.10+0.15+0.20+0.9+0.6)/6 ≈ 0.333 — clearly wrong.
    const mixed = [
      // Day A: four 15-min slots + paired hourly
      row15('2026-06-07T13:00:00-04:00', 0.05),
      row15('2026-06-07T13:15:00-04:00', 0.10),
      row15('2026-06-07T13:30:00-04:00', 0.15),
      row15('2026-06-07T13:45:00-04:00', 0.20),
      row60('2026-06-07T13:00:00-04:00', 0.9),
      // Day B: only an hourly
      row60('2026-06-08T13:00:00-04:00', 0.6),
    ];

    const reconciled = reconcileToHourly(mixed);
    // Reconciled: 2 rows (one per calendar-day), both at the 13:00 UTC-hour boundary.
    expect(reconciled).toHaveLength(2);
    // Day A → sum of 15-min slots wins
    expect(reconciled[0].quantity).toBeCloseTo(0.5, 10);
    // Day B → hourly passes through
    expect(reconciled[1].quantity).toBeCloseTo(0.6, 10);

    const profile = averageDayProfile(reconciled, { tz: TZ });
    expect(profile).toHaveLength(1);
    const bucket = profile[0];
    expect(bucket.label).toBe('13:00');
    // mean = (0.5 + 0.6) / 2 = 0.55  ← correct, no double-count
    expect(bucket.mean).toBeCloseTo(0.55, 10);
    expect(bucket.count).toBe(2);

    // Contrast: raw mixed rows fed directly → wrong mean ≈ 0.333 (6 entries summed)
    const profileRaw = averageDayProfile(mixed, { tz: TZ });
    expect(profileRaw[0].count).toBe(6);
    expect(profileRaw[0].mean).not.toBeCloseTo(0.55, 5); // double-count is real
  });
});
