import { describe, expect, it } from 'vitest';
import {
  buildHeatmapPayload,
  buildProfilePayload,
  type RawIntervalRow,
} from '../src/lib/intervalAggregate';

// Hand-calculated tests for the PURE display-ready interval aggregator (issue #77).
// This is the thin layer the new /api/interval/heatmap + /api/interval/profile
// routes call: it composes the already-tested shapers into the exact JSON the
// widgets render. We verify the COMPOSITION + the wire shape (the heatmap grid is
// populated for cells that truly have data and null for genuinely-absent ones; the
// profile payload carries every split × granularity variant; peak is over the raw
// finest grain; the unsettled-tail cutoff is applied).
//
// All instants are written as ISO strings WITH an explicit offset so the UTC
// instant is unambiguous; the shapers bin by LOCAL time-of-day in
// America/New_York (the default tz), which in June is EDT (-04:00).
const TZ = 'America/New_York';

describe('buildHeatmapPayload (hand-calculated)', () => {
  it('populates only the (dow, hour) cells that truly have data; absent cells are null', () => {
    // Two distinct local cells:
    //   Sun (dow 0) 13:00 — one hourly read of 2.0
    //   Mon (dow 1) 14:00 — one hourly read of 4.0
    // 2026-06-07 is a Sunday, 2026-06-08 a Monday (EDT).
    const rows: RawIntervalRow[] = [
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T13:00:00-04:00', intervalSeconds: 3600, quantity: 2.0 },
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-08T14:00:00-04:00', intervalSeconds: 3600, quantity: 4.0 },
    ];
    const { grid, rowLabels } = buildHeatmapPayload(rows, { tz: TZ });

    // Two distinct x bins (13, 14) × two distinct y bins (0=Sun, 1=Mon) → a 2×2
    // rectangular grid (4 cells), of which only two are populated.
    expect(grid.xs).toEqual([13, 14]);
    expect(grid.ys).toEqual([0, 1]);
    expect(grid.cells).toHaveLength(4);
    expect(grid.min).toBeCloseTo(2.0, 10);
    expect(grid.max).toBeCloseTo(4.0, 10);

    const at = (x: number, y: number) => grid.cells.find((c) => c.x === x && c.y === y)!;
    expect(at(13, 0).value).toBeCloseTo(2.0, 10); // Sun 13:00 populated
    expect(at(14, 1).value).toBeCloseTo(4.0, 10); // Mon 14:00 populated
    expect(at(14, 0).value).toBeNull(); // Sun 14:00 genuinely absent → null, NOT 0
    expect(at(13, 1).value).toBeNull(); // Mon 13:00 genuinely absent → null, NOT 0

    expect(rowLabels[0]).toBe('Sun');
    expect(rowLabels[1]).toBe('Mon');
  });

  it('reconciles four complete 15-min slots into the hour before binning (no quadruple count)', () => {
    // Four 15-min electric reads in Sun 13:00 (EDT), summing to 0.2+0.4+0.6+0.8=2.0.
    // reconcileToHourly collapses them to one hourly row of 2.0 → cell value 2.0
    // (NOT the 0.5 mean of four independent reads).
    const rows: RawIntervalRow[] = [
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T13:00:00-04:00', intervalSeconds: 900, quantity: 0.2 },
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T13:15:00-04:00', intervalSeconds: 900, quantity: 0.4 },
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T13:30:00-04:00', intervalSeconds: 900, quantity: 0.6 },
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T13:45:00-04:00', intervalSeconds: 900, quantity: 0.8 },
    ];
    const { grid } = buildHeatmapPayload(rows, { tz: TZ });
    expect(grid.xs).toEqual([13]);
    expect(grid.ys).toEqual([0]);
    const cell = grid.cells.find((c) => c.x === 13 && c.y === 0)!;
    expect(cell.value).toBeCloseTo(2.0, 10);
    expect(cell.count).toBe(1); // one reconciled hourly read, not four
  });

  it('peak is over the raw finest grain (a 15-min spike beats its hour mean)', () => {
    // Hour with a single hot 15-min slot: 0.1, 0.1, 0.1, 0.9 kWh.
    // Reconciled hour = 1.2 kWh → 1.2 kW average power.
    // The raw 0.9 kWh 15-min slot = 0.9 / 0.25 = 3.6 kW → that's the peak.
    const rows: RawIntervalRow[] = [
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T13:00:00-04:00', intervalSeconds: 900, quantity: 0.1 },
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T13:15:00-04:00', intervalSeconds: 900, quantity: 0.1 },
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T13:30:00-04:00', intervalSeconds: 900, quantity: 0.1 },
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T13:45:00-04:00', intervalSeconds: 900, quantity: 0.9 },
    ];
    const { peak } = buildHeatmapPayload(rows, { tz: TZ });
    expect(peak).not.toBeNull();
    expect(peak!.value).toBeCloseTo(3.6, 10);
    expect(peak!.intervalSeconds).toBe(900);
    // intervalStart serialized as an ISO string (the 13:45 EDT slot = 17:45 UTC).
    expect(typeof peak!.intervalStart).toBe('string');
    expect(new Date(peak!.intervalStart).toISOString()).toBe('2026-06-07T17:45:00.000Z');
  });

  it('excludes reads at/after the unsettled-tail cutoff from grid + peak', () => {
    // One settled read (well before the cutoff) and one read AT the cutoff. The
    // cutoff read must be excluded from both the grid and the peak.
    const before = new Date('2026-06-10T00:00:00Z');
    const rows: RawIntervalRow[] = [
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T13:00:00-04:00', intervalSeconds: 3600, quantity: 2.0 },
      // 2026-06-10T00:00:00Z is exactly the cutoff → dropped (>= before).
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-10T00:00:00Z', intervalSeconds: 3600, quantity: 99.0 },
    ];
    const { grid, peak } = buildHeatmapPayload(rows, { tz: TZ, before });
    // Only the settled 2.0 read survives.
    expect(grid.max).toBeCloseTo(2.0, 10);
    expect(peak!.value).toBeCloseTo(2.0, 10);
  });

  it('empty input yields an empty rectangular grid with a sane 0..0 scale and no peak', () => {
    const { grid, rowLabels, peak } = buildHeatmapPayload([], { tz: TZ });
    expect(grid.xs).toEqual([]);
    expect(grid.ys).toEqual([]);
    expect(grid.cells).toEqual([]);
    expect(grid.min).toBe(0);
    expect(grid.max).toBe(0);
    expect(rowLabels).toEqual({});
    expect(peak).toBeNull();
  });
});

describe('buildProfilePayload (hand-calculated)', () => {
  it('carries every split × granularity variant in one payload', () => {
    // A handful of electric 15-min reads across a weekday and a weekend day.
    // 2026-06-08 = Monday (weekday), 2026-06-07 = Sunday (weekend), EDT.
    const rows: RawIntervalRow[] = [
      // Monday 13:00–13:45 → four complete slots summing to 2.0.
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-08T13:00:00-04:00', intervalSeconds: 900, quantity: 0.2 },
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-08T13:15:00-04:00', intervalSeconds: 900, quantity: 0.4 },
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-08T13:30:00-04:00', intervalSeconds: 900, quantity: 0.6 },
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-08T13:45:00-04:00', intervalSeconds: 900, quantity: 0.8 },
      // Sunday 08:00 single 15-min slot of 1.0.
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T08:00:00-04:00', intervalSeconds: 900, quantity: 1.0 },
    ];
    const { variants } = buildProfilePayload(rows, { tz: TZ });

    // Both granularities present, each with the three splits.
    expect(Object.keys(variants).sort()).toEqual(['15', '60']);
    for (const g of ['15', '60'] as const) {
      expect(variants[g]).toHaveProperty('combined');
      expect(variants[g]).toHaveProperty('weekday');
      expect(variants[g]).toHaveProperty('weekend');
    }

    // 1h COMBINED: the Monday four-slot hour reconciles to 2.0 in the 13:00 bucket;
    // the lone Sunday slot is a partial hour with no hourly row → SKIPPED at 1h.
    const h60c = variants['60'].combined;
    const b13 = h60c.find((b) => b.minutes === 13 * 60);
    expect(b13).toBeTruthy();
    expect(b13!.mean).toBeCloseTo(2.0, 10);
    // The Sunday partial hour is absent at 1h (reconcileToHourly drops it).
    expect(h60c.find((b) => b.minutes === 8 * 60)).toBeUndefined();

    // 1h WEEKDAY has the Monday 13:00 bucket; 1h WEEKEND has none (Sunday dropped).
    expect(variants['60'].weekday.find((b) => b.minutes === 13 * 60)!.mean).toBeCloseTo(2.0, 10);
    expect(variants['60'].weekend).toEqual([]);

    // 15m granularity keeps the raw slots: COMBINED has four Monday 15-min buckets
    // (13:00/13:15/13:30/13:45) plus the Sunday 08:00 bucket = 5 buckets.
    const m15c = variants['15'].combined;
    expect(m15c).toHaveLength(5);
    expect(m15c.find((b) => b.minutes === 8 * 60)!.mean).toBeCloseTo(1.0, 10); // Sunday slot kept at 15m
    // 15m WEEKEND now has the Sunday slot (it's a raw 15-min read, not a partial hour).
    expect(variants['15'].weekend.find((b) => b.minutes === 8 * 60)!.mean).toBeCloseTo(1.0, 10);
  });

  it('peak is over the raw finest grain and excludes the unsettled tail', () => {
    const before = new Date('2026-06-10T00:00:00Z');
    const rows: RawIntervalRow[] = [
      // settled 15-min spike: 0.75 kWh / 0.25h = 3.0 kW
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-07T13:00:00-04:00', intervalSeconds: 900, quantity: 0.75 },
      // a bigger spike but AT/after the cutoff → must be excluded
      { fuelType: 'ELECTRIC', intervalStart: '2026-06-11T13:00:00-04:00', intervalSeconds: 900, quantity: 5.0 },
    ];
    const { peak } = buildProfilePayload(rows, { tz: TZ, before });
    expect(peak!.value).toBeCloseTo(3.0, 10);
  });

  it('empty input yields empty variants and no peak', () => {
    const { variants, peak } = buildProfilePayload([], { tz: TZ });
    expect(variants['60'].combined).toEqual([]);
    expect(variants['60'].weekday).toEqual([]);
    expect(variants['60'].weekend).toEqual([]);
    expect(variants['15'].combined).toEqual([]);
    expect(peak).toBeNull();
  });
});
