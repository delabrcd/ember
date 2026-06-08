import { describe, expect, it } from 'vitest';
import type { MonthRow } from '../src/lib/chartSpec';
import {
  projectBudget,
  calendarYearWindow,
  BUDGET_ON_TRACK_TOL,
  type BudgetFuturePeriod,
} from '../src/lib/series';

// Minimal MonthRow factory (mirrors the other pure-series tests). Only billTotal
// (= currentCharges) and ym/kwh matter for the budget math.
const mkRow = (over: Partial<MonthRow>): MonthRow => ({
  ym: 0, label: '', kwh: null, therms: null,
  elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
  elecBill: null, gasBill: null,
  elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
  avgTemp: null, billTotal: null, days: null,
  hdd: null, cdd: null, kwhPerDegreeDay: null, thermsPerHdd: null, ...over,
});

const win = { fromYm: 202401, toYm: 202412 };

describe('calendarYearWindow', () => {
  it('spans Jan–Dec of the ym year', () => {
    expect(calendarYearWindow(202405)).toEqual({ fromYm: 202401, toYm: 202412 });
    expect(calendarYearWindow(202512)).toEqual({ fromYm: 202501, toYm: 202512 });
  });
});

describe('projectBudget (hand-calculated)', () => {
  // Four in-window bills (currentCharges), one out-of-window bill that must NOT
  // count, plus one remaining period from the next-bill estimate.
  //   Jan 200, Feb 250, Mar 180, Apr 220  -> spent = 850
  //   2023-12 (out of window) 999 must be ignored.
  // Next bill = May 2024 (the month after the latest billed Apr), point 210,
  // band 180–240 (half-width 30).
  //   remaining = 210
  //   projected = 850 + 210 = 1060
  //   band half = sqrt(30^2) = 30  -> projectedLow 1030, projectedHigh 1090.
  const rows: MonthRow[] = [
    mkRow({ ym: 202312, billTotal: 999, kwh: 100 }), // out of window — ignored
    mkRow({ ym: 202401, billTotal: 200, kwh: 100 }),
    mkRow({ ym: 202402, billTotal: 250, kwh: 100 }),
    mkRow({ ym: 202403, billTotal: 180, kwh: 100 }),
    mkRow({ ym: 202404, billTotal: 220, kwh: 100 }),
  ];
  const nextBill: BudgetFuturePeriod = { ym: 202405, point: 210, low: 180, high: 240 };

  it('sums spent from in-window currentCharges and projects the remainder', () => {
    const b = projectBudget(rows, 3000, win, { nextBill })!;
    expect(b).not.toBeNull();
    expect(b.spent).toBe(850); // 200+250+180+220 (the 999 out-of-window bill excluded)
    expect(b.billsCounted).toBe(4);
    expect(b.remaining).toBe(210);
    expect(b.remainingPeriods).toBe(1);
    expect(b.projected).toBe(1060);
    expect(b.projectedLow).toBe(1030); // 1060 - 30
    expect(b.projectedHigh).toBe(1090); // 1060 + 30
  });

  it('ASSERTS spent uses billTotal (currentCharges), NEVER the statement amount due', () => {
    // billTotal IS the currentCharges-sourced figure (queries.ts shapeBill /
    // getMonthlySeries pass currentCharges into it). Changing only billTotal must
    // change spent 1:1; nothing else on the row feeds it.
    const base = projectBudget(rows, 3000, win, { nextBill })!;
    const bumped = projectBudget(
      rows.map((r) => (r.ym === 202401 ? { ...r, billTotal: 200 + 75 } : r)),
      3000,
      win,
      { nextBill }
    )!;
    expect(bumped.spent - base.spent).toBe(75);
    // A row with NO billTotal contributes nothing even if it has usage.
    const noBill = projectBudget(
      [mkRow({ ym: 202401, billTotal: null, kwh: 12345 })],
      3000,
      win
    )!;
    expect(noBill.spent).toBe(0);
    expect(noBill.billsCounted).toBe(0);
  });

  it('flags over budget when projected exceeds the target beyond tolerance', () => {
    // target 1000, projected 1060 -> delta +60, tol = 2% * 1000 = 20 -> over.
    const b = projectBudget(rows, 1000, win, { nextBill })!;
    expect(b.delta).toBe(60);
    expect(b.status).toBe('over');
  });

  it('flags under budget when projected is below the target beyond tolerance', () => {
    // target 2000, projected 1060 -> delta -940 -> under.
    const b = projectBudget(rows, 2000, win, { nextBill })!;
    expect(b.delta).toBe(-940);
    expect(b.status).toBe('under');
  });

  it('reads on_track inside the ±tolerance band of the target', () => {
    // projected 1060; target 1060 -> delta 0 -> on_track.
    expect(projectBudget(rows, 1060, win, { nextBill })!.status).toBe('on_track');
    // target 1050 -> delta +10, tol = 2% * 1050 = 21 -> still on_track.
    expect(projectBudget(rows, 1050, win, { nextBill })!.status).toBe('on_track');
    // target 1075 -> delta -15, tol = 2% * 1075 = 21.5 -> on_track.
    expect(projectBudget(rows, 1075, win, { nextBill })!.status).toBe('on_track');
    // sanity: BUDGET_ON_TRACK_TOL is the documented 2%.
    expect(BUDGET_ON_TRACK_TOL).toBe(0.02);
  });

  it('combines multiple remaining-period bands in quadrature', () => {
    // Next bill May 210 (band ±30) + two seasonal months in-window:
    //   Jun 200 (band ±40), Jul 190 (band ±0 -> degenerate, contributes nothing).
    // remaining = 210 + 200 + 190 = 600; projected = 850 + 600 = 1450.
    // band half = sqrt(30^2 + 40^2 + 0^2) = sqrt(900+1600) = sqrt(2500) = 50.
    const seasonMonths: BudgetFuturePeriod[] = [
      { ym: 202406, point: 200, low: 160, high: 240 }, // ±40
      { ym: 202407, point: 190, low: 190, high: 190 }, // ±0
    ];
    const b = projectBudget(rows, 3000, win, { nextBill, seasonMonths })!;
    expect(b.remaining).toBe(600);
    expect(b.remainingPeriods).toBe(3);
    expect(b.projected).toBe(1450);
    expect(b.projectedHigh).toBe(1500); // 1450 + 50
    expect(b.projectedLow).toBe(1400); // 1450 - 50
  });

  it('does NOT double-count a future period that overlaps an already-billed month', () => {
    // A seasonal month for an ALREADY-billed in-window month (Apr) must be dropped;
    // only periods strictly after the latest billed month (Apr -> May+) count.
    const seasonMonths: BudgetFuturePeriod[] = [
      { ym: 202404, point: 9999, low: 9999, high: 9999 }, // already billed -> excluded
      { ym: 202405, point: 100, low: 100, high: 100 }, // same as next-bill ym -> next-bill wins
      { ym: 202406, point: 200, low: 200, high: 200 },
    ];
    const b = projectBudget(rows, 3000, win, { nextBill, seasonMonths })!;
    // remaining = next-bill May 210 (NOT the 100 seasonal dup) + Jun 200 = 410.
    expect(b.remaining).toBe(410);
    expect(b.remainingPeriods).toBe(2);
  });

  it('excludes future periods that fall outside the window', () => {
    // A seasonal month in the NEXT year (out of the 2024 window) must not count.
    const seasonMonths: BudgetFuturePeriod[] = [
      { ym: 202501, point: 300, low: 300, high: 300 }, // 2025 -> out of window
    ];
    const b = projectBudget(rows, 3000, win, { nextBill, seasonMonths })!;
    expect(b.remaining).toBe(210); // only the May next-bill
    expect(b.remainingPeriods).toBe(1);
  });

  it('handles a target with no spend or projection yet', () => {
    const b = projectBudget([], 1200, win)!;
    expect(b.spent).toBe(0);
    expect(b.remaining).toBe(0);
    expect(b.projected).toBe(0);
    expect(b.status).toBe('under'); // projected 0 << target
  });

  it('returns null when no target is set or the target is invalid', () => {
    expect(projectBudget(rows, null, win, { nextBill })).toBeNull();
    expect(projectBudget(rows, undefined, win, { nextBill })).toBeNull();
    expect(projectBudget(rows, 0, win, { nextBill })).toBeNull();
    expect(projectBudget(rows, -100, win, { nextBill })).toBeNull();
    expect(projectBudget(rows, Number.NaN, win, { nextBill })).toBeNull();
  });
});
