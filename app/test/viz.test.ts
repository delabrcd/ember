import { describe, expect, it } from 'vitest';
import {
  colorScale01,
  dayHourHeatmap,
  heatmapRowLabels,
  hourOfDayProfile,
  scatterPoints,
} from '../src/lib/viz/aggregate';
import { sampleIntervalRows } from '../src/lib/viz/sampleInterval';
import type {
  HeatmapEncoding,
  ProfileEncoding,
  ScatterEncoding,
} from '../src/lib/chartSpec';

// Hand-calculated unit tests for the Phase C viz aggregation (issue #95; the
// AGENTS.md "new viz aggregation is pure + tested" rule). A tiny fixture with a
// KNOWN answer drives each aggregator: 3 days × 2 hours of interval-shaped rows
// with a couple of deliberately-missing readings, plus a monthly-shaped fixture
// for scatter. Every expected number is computed by hand in the comments.

// --- fixture --------------------------------------------------------------
// Interval-shaped rows: { day, hour, kwh }. Per (day, hour) there's one reading;
// we add two BAD rows (null + NaN kwh) that every aggregator must drop.
interface Row {
  day: number;
  hour: number;
  kwh: number | null;
  label?: string;
}
const fixture: Row[] = [
  { day: 0, hour: 0, kwh: 1, label: 'Mon' },
  { day: 0, hour: 1, kwh: 3, label: 'Mon' },
  { day: 1, hour: 0, kwh: 2, label: 'Tue' },
  { day: 1, hour: 1, kwh: 5, label: 'Tue' },
  { day: 2, hour: 0, kwh: 3, label: 'Wed' },
  { day: 2, hour: 1, kwh: 7, label: 'Wed' },
  { day: 0, hour: 0, kwh: null, label: 'Mon' }, // dropped (missing)
  { day: 1, hour: 1, kwh: NaN, label: 'Tue' }, // dropped (NaN)
];

// ---------------------------------------------------------------------------
// scatterPoints
// ---------------------------------------------------------------------------
describe('scatterPoints', () => {
  const enc: ScatterEncoding<Row> = { x: 'day', y: 'kwh', label: 'label' };

  it('emits one point per row with both x and y present, dropping null/NaN y', () => {
    const pts = scatterPoints(fixture, enc);
    // 8 rows, 2 have null/NaN kwh → 6 points.
    expect(pts.length).toBe(6);
    // First point: day 0, kwh 1, label 'Mon'.
    expect(pts[0]).toEqual({ x: 0, y: 1, label: 'Mon' });
  });

  it('drops a row when the X field is missing too (not just Y)', () => {
    const withBadX: Row[] = [
      { day: NaN, hour: 0, kwh: 5 },
      { day: 4, hour: 0, kwh: 6 },
    ];
    const pts = scatterPoints(withBadX, { x: 'day', y: 'kwh' });
    expect(pts).toEqual([{ x: 4, y: 6 }]);
  });

  it('omits the label when no label field is encoded', () => {
    const pts = scatterPoints([{ day: 1, hour: 0, kwh: 2 }], { x: 'day', y: 'kwh' });
    expect(pts[0]).toEqual({ x: 1, y: 2 });
    expect('label' in pts[0]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hourOfDayProfile
// ---------------------------------------------------------------------------
describe('hourOfDayProfile', () => {
  const enc: ProfileEncoding<Row> = { bucket: 'hour', value: 'kwh' };

  it('means per bucket, sorted, dropping missing readings', () => {
    const buckets = hourOfDayProfile(fixture, enc);
    expect(buckets.map((b) => b.bucket)).toEqual([0, 1]);
    // hour 0: kwh values [1, 2, 3] (the null is dropped) → mean 2, count 3.
    // hour 1: kwh values [3, 5, 7] (the NaN is dropped) → mean 5, count 3.
    expect(buckets[0]).toMatchObject({ bucket: 0, value: 2, count: 3 });
    expect(buckets[1]).toMatchObject({ bucket: 1, value: 5, count: 3 });
  });

  it('computes a population std-dev band (÷N), lower clamped at 0', () => {
    const [h0, h1] = hourOfDayProfile(fixture, enc);
    // hour 0 std = sqrt(((1-2)^2+(2-2)^2+(3-2)^2)/3) = sqrt(2/3) ≈ 0.8165
    expect(h0.std).toBeCloseTo(Math.sqrt(2 / 3), 10);
    expect(h0.lower).toBeCloseTo(2 - Math.sqrt(2 / 3), 10);
    expect(h0.upper).toBeCloseTo(2 + Math.sqrt(2 / 3), 10);
    // hour 1 std = sqrt(((3-5)^2+(5-5)^2+(7-5)^2)/3) = sqrt(8/3) ≈ 1.6330
    expect(h1.std).toBeCloseTo(Math.sqrt(8 / 3), 10);
  });

  it('clamps the lower band at 0 (usage cannot go negative)', () => {
    // value 1 with a large spread → lower would be negative, clamp to 0.
    const rows: Row[] = [
      { day: 0, hour: 5, kwh: 0 },
      { day: 1, hour: 5, kwh: 0 },
      { day: 2, hour: 5, kwh: 9 },
    ];
    const [b] = hourOfDayProfile(rows, enc);
    expect(b.value).toBeCloseTo(3, 10); // mean (0+0+9)/3
    expect(b.lower).toBe(0); // 3 − std(≈4.24) clamped
  });

  it('supports median aggregation', () => {
    // hour 0 values [1,2,3] → median 2; even-count median averages the middle two.
    const rows: Row[] = [
      { day: 0, hour: 0, kwh: 1 },
      { day: 1, hour: 0, kwh: 2 },
      { day: 2, hour: 0, kwh: 3 },
      { day: 3, hour: 0, kwh: 10 },
    ];
    const [b] = hourOfDayProfile(rows, { bucket: 'hour', value: 'kwh', agg: 'median' });
    expect(b.value).toBe(2.5); // (2 + 3) / 2
  });
});

// ---------------------------------------------------------------------------
// dayHourHeatmap + colorScale01
// ---------------------------------------------------------------------------
describe('dayHourHeatmap', () => {
  const enc: HeatmapEncoding<Row> = { x: 'hour', y: 'day', value: 'kwh' };

  it('bins into a full rectangular grid with per-cell means and a data domain', () => {
    const grid = dayHourHeatmap(fixture, enc);
    expect(grid.xs).toEqual([0, 1]); // hours present
    expect(grid.ys).toEqual([0, 1, 2]); // days present
    // 2 cols × 3 rows = 6 cells, row-major by y then x.
    expect(grid.cells.length).toBe(6);
    // Each (day,hour) bin had exactly one valid reading → mean = that value.
    // min over cells = 1 (day0,hour0), max = 7 (day2,hour1).
    expect(grid.min).toBe(1);
    expect(grid.max).toBe(7);
    // Spot-check a cell: day 2, hour 1 → value 7, count 1.
    const cell = grid.cells.find((c) => c.x === 1 && c.y === 2);
    expect(cell).toMatchObject({ x: 1, y: 2, value: 7, count: 1 });
  });

  it('averages multiple rows that share a bin', () => {
    const rows: Row[] = [
      { day: 0, hour: 0, kwh: 2 },
      { day: 0, hour: 0, kwh: 4 }, // same bin → mean 3
    ];
    const grid = dayHourHeatmap(rows, enc);
    expect(grid.cells).toHaveLength(1);
    expect(grid.cells[0]).toMatchObject({ x: 0, y: 0, value: 3, count: 2 });
  });

  it('emits a null-valued cell for an empty bin so the grid stays rectangular', () => {
    // Two days, two hours, but the (day1, hour1) bin has no reading.
    const rows: Row[] = [
      { day: 0, hour: 0, kwh: 1 },
      { day: 0, hour: 1, kwh: 2 },
      { day: 1, hour: 0, kwh: 3 },
    ];
    const grid = dayHourHeatmap(rows, enc);
    expect(grid.cells.length).toBe(4); // 2×2 full grid
    const empty = grid.cells.find((c) => c.x === 1 && c.y === 1);
    expect(empty).toMatchObject({ value: null, count: 0 });
  });

  it('collapses to a 0..0 domain when nothing is populated', () => {
    const grid = dayHourHeatmap([{ day: 0, hour: 0, kwh: null }], enc);
    expect(grid.min).toBe(0);
    expect(grid.max).toBe(0);
  });
});

describe('colorScale01', () => {
  it('maps within [min,max] to 0..1 and clamps outside', () => {
    expect(colorScale01(1, 1, 7)).toBe(0); // at min
    expect(colorScale01(7, 1, 7)).toBe(1); // at max
    expect(colorScale01(4, 1, 7)).toBeCloseTo(0.5, 10); // midpoint
    expect(colorScale01(-5, 1, 7)).toBe(0); // below min clamps
    expect(colorScale01(99, 1, 7)).toBe(1); // above max clamps
  });

  it('maps a degenerate domain (min===max) to the middle, never NaN', () => {
    expect(colorScale01(5, 5, 5)).toBe(0.5);
    expect(Number.isNaN(colorScale01(5, 5, 5))).toBe(false);
  });
});

describe('heatmapRowLabels', () => {
  it('builds a y-bin → label map (first label per bin wins)', () => {
    const enc: HeatmapEncoding<Row> = { x: 'hour', y: 'day', value: 'kwh', yLabelField: 'label' };
    const labels = heatmapRowLabels(fixture, enc);
    expect(labels).toEqual({ 0: 'Mon', 1: 'Tue', 2: 'Wed' });
  });

  it('is empty when no yLabelField is encoded', () => {
    expect(heatmapRowLabels(fixture, { x: 'hour', y: 'day', value: 'kwh' })).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// sampleIntervalRows (deterministic synthetic generator)
// ---------------------------------------------------------------------------
describe('sampleIntervalRows', () => {
  it('generates days × 24 hourly rows, deterministically', () => {
    const a = sampleIntervalRows(7);
    const b = sampleIntervalRows(7);
    expect(a.length).toBe(7 * 24);
    expect(a).toEqual(b); // same seed → identical output
  });

  it('covers every hour 0–23 for each day and never goes negative', () => {
    const rows = sampleIntervalRows(3);
    const hoursDay0 = rows.filter((r) => r.day === 0).map((r) => r.hour);
    expect(hoursDay0).toEqual([...Array(24).keys()]);
    expect(rows.every((r) => r.kwh >= 0)).toBe(true);
  });

  it('feeds the profile aggregator a 24-bucket curve', () => {
    const rows = sampleIntervalRows(7);
    const buckets = hourOfDayProfile(rows, { bucket: 'hour', value: 'kwh' });
    expect(buckets.length).toBe(24);
    expect(buckets.map((b) => b.bucket)).toEqual([...Array(24).keys()]);
  });
});
