import { describe, expect, it } from 'vitest';
import { toFifteenMinGrid, type GridInputRow } from '../src/lib/viz/fifteenMinGrid';

// Hand-calculated tests for the PURE 15-minute-grid shaper (WS1 rework of #36).
// Given raw 900s + 3600s rows for a small window, toFifteenMinGrid builds a uniform
// 15-min line:
//   • real 900s slots → passed through,
//   • hourly-only hours → four equal quarter-steps of hourlyQuantity/4 (so the line
//     sits at 15-min magnitude AND the four slots SUM to the hourly value),
//   • neither grain → gap (omitted; never a fabricated zero).
// DISPLAY-only — never a billed number.

const FIFTEEN = 15 * 60_000;
const HOUR = 60 * 60_000;
const BASE = Date.UTC(2026, 5, 10, 0, 0, 0); // 2026-06-10T00:00:00Z (a clean hour)

function slot900(offsetMs: number, q: number): GridInputRow {
  return { intervalStart: new Date(BASE + offsetMs), intervalSeconds: 900, quantity: q, fuelType: 'ELECTRIC', unit: 'kWh' };
}
function hour3600(offsetMs: number, q: number): GridInputRow {
  return { intervalStart: new Date(BASE + offsetMs), intervalSeconds: 3600, quantity: q, fuelType: 'ELECTRIC', unit: 'kWh' };
}

describe('toFifteenMinGrid', () => {
  it('passes real 15-min slots through unchanged', () => {
    // Hour 0 has all four real 15-min slots: 0.1, 0.2, 0.3, 0.4.
    const rows = [slot900(0, 0.1), slot900(FIFTEEN, 0.2), slot900(2 * FIFTEEN, 0.3), slot900(3 * FIFTEEN, 0.4)];
    const out = toFifteenMinGrid(rows, BASE, BASE + HOUR);
    expect(out).toHaveLength(4);
    expect(out.map((p) => p.quantity)).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(out.every((p) => p.intervalSeconds === 900)).toBe(true);
    // Ascending, aligned to :00/:15/:30/:45.
    expect(out.map((p) => p.intervalStart.getTime())).toEqual([
      BASE, BASE + FIFTEEN, BASE + 2 * FIFTEEN, BASE + 3 * FIFTEEN,
    ]);
  });

  it('splits an hourly-only hour into four equal quarter-steps that SUM to the hour', () => {
    // Hour 0 has ONLY an hourly row (no 15-min): quantity 2.0 → four slots of 0.5.
    const rows = [hour3600(0, 2.0)];
    const out = toFifteenMinGrid(rows, BASE, BASE + HOUR);
    expect(out).toHaveLength(4);
    expect(out.map((p) => p.quantity)).toEqual([0.5, 0.5, 0.5, 0.5]);
    // Energy is conserved: the four quarter-steps re-sum to the hourly value.
    const sum = out.reduce((s, p) => s + p.quantity, 0);
    expect(sum).toBeCloseTo(2.0, 10);
    expect(out.every((p) => p.intervalSeconds === 900)).toBe(true);
  });

  it('emits real slots where present and quarter-steps for the hourly-only hour (no cliff)', () => {
    // Hour 0: real 15-min (each 0.25 → 15-min magnitude). Hour 1: hourly-only 1.0 →
    // four 0.25 quarter-steps — the SAME magnitude as hour 0's real slots, so no
    // vertical cliff at the 15-min/hourly boundary.
    const rows = [
      slot900(0, 0.25), slot900(FIFTEEN, 0.25), slot900(2 * FIFTEEN, 0.25), slot900(3 * FIFTEEN, 0.25),
      hour3600(HOUR, 1.0),
    ];
    const out = toFifteenMinGrid(rows, BASE, BASE + 2 * HOUR);
    expect(out).toHaveLength(8);
    expect(out.map((p) => p.quantity)).toEqual([0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25, 0.25]);
  });

  it('leaves a GAP (omits slots) for an hour with neither grain — never a zero', () => {
    // Hour 0 real, hour 1 ABSENT (no 900s, no 3600s), hour 2 hourly-only.
    const rows = [
      slot900(0, 0.3), slot900(FIFTEEN, 0.3), slot900(2 * FIFTEEN, 0.3), slot900(3 * FIFTEEN, 0.3),
      hour3600(2 * HOUR, 0.8),
    ];
    const out = toFifteenMinGrid(rows, BASE, BASE + 3 * HOUR);
    // Hour 0: 4 real + Hour 2: 4 quarter-steps = 8 points; hour 1 contributes NONE
    // (the gap is omitted, not zero-filled).
    expect(out).toHaveLength(8);
    // No point falls inside hour 1 [BASE+HOUR, BASE+2*HOUR).
    const inHour1 = out.filter((p) => p.intervalStart.getTime() >= BASE + HOUR && p.intervalStart.getTime() < BASE + 2 * HOUR);
    expect(inHour1).toHaveLength(0);
    // And no fabricated zeros anywhere.
    expect(out.every((p) => p.quantity > 0)).toBe(true);
  });

  it('prefers a real 15-min slot over the hourly row when both exist for the hour', () => {
    // Hour 0 has BOTH a (partial) real 15-min set AND an hourly row. Each present
    // real slot wins for its slot; the missing slots fall back to the hour's
    // quarter-step. (This mirrors "real where present" — the hourly only fills the
    // slots that have no 900s reading.)
    const rows = [slot900(0, 0.6), slot900(2 * FIFTEEN, 0.7), hour3600(0, 4.0)];
    const out = toFifteenMinGrid(rows, BASE, BASE + HOUR);
    expect(out).toHaveLength(4);
    // slot 0 → real 0.6; slot 1 → quarter-step 1.0; slot 2 → real 0.7; slot 3 → quarter-step 1.0.
    expect(out.map((p) => p.quantity)).toEqual([0.6, 1.0, 0.7, 1.0]);
  });

  it('snaps the window start down to the 15-min boundary and excludes the end instant', () => {
    // from is 7 minutes into hour 0; the grid snaps DOWN to BASE. to is exactly the
    // hour boundary; slots strictly before `to` only.
    const rows = [slot900(0, 0.1), slot900(FIFTEEN, 0.2), slot900(2 * FIFTEEN, 0.3), slot900(3 * FIFTEEN, 0.4)];
    const out = toFifteenMinGrid(rows, BASE + 7 * 60_000, BASE + HOUR);
    expect(out.map((p) => p.intervalStart.getTime())).toEqual([
      BASE, BASE + FIFTEEN, BASE + 2 * FIFTEEN, BASE + 3 * FIFTEEN,
    ]);
  });

  it('returns empty for a degenerate window and tolerates string timestamps', () => {
    expect(toFifteenMinGrid([hour3600(0, 1)], BASE, BASE)).toEqual([]); // to ≤ from
    expect(toFifteenMinGrid([hour3600(0, 1)], BASE, BASE - HOUR)).toEqual([]);
    // ISO-string intervalStart (a JSON round-trip) is handled the same as a Date.
    const strRows: GridInputRow[] = [
      { intervalStart: new Date(BASE).toISOString(), intervalSeconds: 3600, quantity: 2.0, fuelType: 'GAS', unit: 'therms' },
    ];
    const out = toFifteenMinGrid(strRows, BASE, BASE + HOUR);
    expect(out.map((p) => p.quantity)).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(out[0].fuelType).toBe('GAS');
    expect(out[0].unit).toBe('therms');
  });

  it('drops rows with a non-finite quantity or unparseable instant before gridding', () => {
    const rows: GridInputRow[] = [
      slot900(0, 0.3),
      { intervalStart: new Date(BASE + FIFTEEN), intervalSeconds: 900, quantity: NaN, fuelType: 'ELECTRIC' },
      { intervalStart: 'not-a-date', intervalSeconds: 3600, quantity: 5, fuelType: 'ELECTRIC' },
      slot900(2 * FIFTEEN, 0.4),
    ];
    const out = toFifteenMinGrid(rows, BASE, BASE + HOUR);
    // Only the two good real slots survive (slots 0 and 2); the bad 900s and the
    // unparseable hourly are dropped → slots 1 and 3 are gaps.
    expect(out.map((p) => [p.intervalStart.getTime() - BASE, p.quantity])).toEqual([
      [0, 0.3],
      [2 * FIFTEEN, 0.4],
    ]);
  });
});
