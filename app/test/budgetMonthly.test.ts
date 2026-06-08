import { describe, expect, it } from 'vitest';
import type { MonthRow } from '../src/lib/chartSpec';
import { budgetMonthly, BUDGET_ON_TRACK_TOL } from '../src/lib/series';

// Minimal MonthRow factory (mirrors budget.test.ts). Only ym + billTotal
// (= currentCharges) matter for the month-by-month budget math.
const mkRow = (over: Partial<MonthRow>): MonthRow => ({
  ym: 0, label: '', kwh: null, therms: null,
  elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
  elecBill: null, gasBill: null,
  elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
  avgTemp: null, billTotal: null, days: null,
  hdd: null, cdd: null, kwhPerDegreeDay: null, thermsPerHdd: null, ...over,
});

const win = { fromYm: 202401, toYm: 202412 };

// Seasonal projected costs by calendar month, chosen to SUM TO 1200 so that, with
// target 1200, each month's expected pace EQUALS its weight (target × w/1200 = w).
// Winter (Jan/Feb/Dec) is much heavier than summer (Jun/Jul/Aug) — a real NY shape.
//   Jan 200, Feb 200, Mar 150, Apr 80, May 40, Jun 30, Jul 30, Aug 30,
//   Sep 40, Oct 80, Nov 140, Dec 180  → Σ = 1200.
// We key them on 2025 calendar months on purpose: budgetMonthly keys seasonal
// weights by CALENDAR MONTH (ym % 100), so a projection that starts in a later
// year still weights the 2024 window correctly.
const SEASON_W: Record<number, number> = {
  1: 200, 2: 200, 3: 150, 4: 80, 5: 40, 6: 30,
  7: 30, 8: 30, 9: 40, 10: 80, 11: 140, 12: 180,
};
const seasonal = Object.entries(SEASON_W).map(([m, projCost]) => ({
  ym: 202500 + Number(m),
  projCost,
}));

describe('budgetMonthly (hand-calculated, seasonally weighted)', () => {
  it('returns null when no/invalid target is set', () => {
    expect(budgetMonthly([], null, win, seasonal)).toBeNull();
    expect(budgetMonthly([], undefined, win, seasonal)).toBeNull();
    expect(budgetMonthly([], 0, win, seasonal)).toBeNull();
    expect(budgetMonthly([], -5, win, seasonal)).toBeNull();
    expect(budgetMonthly([], Number.NaN, win, seasonal)).toBeNull();
  });

  it('produces one entry per window month with seasonal (non-flat) shares', () => {
    const r = budgetMonthly([], 1200, win, seasonal)!;
    expect(r.seasonal).toBe(true);
    expect(r.months).toHaveLength(12);
    // shares sum to 1 and are NOT flat (winter > summer).
    const shareSum = r.months.reduce((s, m) => s + m.share, 0);
    expect(shareSum).toBeCloseTo(1, 10);
    const jan = r.months[0];
    const jun = r.months[5];
    expect(jan.share).toBeGreaterThan(jun.share);
    // With target 1200 and weights summing to 1200, expected == weight.
    expect(jan.expected).toBeCloseTo(200, 10); // Jan weight 200
    expect(jun.expected).toBeCloseTo(30, 10); // Jun weight 30
    // and clearly NOT the flat 100 = 1200/12.
    expect(jan.expected).not.toBeCloseTo(100, 5);
  });

  it('SEASONAL FAIRNESS: a Jan that reads "over" on a flat budget is "on track" on its seasonal share', () => {
    // Jan billed at 200. Flat expected = 1200/12 = 100 → over by 100 on a flat
    // budget. Seasonal expected for Jan = 200 → cumulative delta 0 → on_track.
    const rows = [mkRow({ ym: 202401, billTotal: 200 })];
    const seasonalRes = budgetMonthly(rows, 1200, win, seasonal)!;
    const janSeasonal = seasonalRes.months[0];
    expect(janSeasonal.actual).toBe(200);
    expect(janSeasonal.expected).toBeCloseTo(200, 10);
    expect(janSeasonal.cumProjected - janSeasonal.cumExpected).toBeCloseTo(0, 10);
    expect(janSeasonal.status).toBe('on_track');

    // SAME row, FLAT fallback (no seasonal) → Jan expected 100, projected 200,
    // cumulative delta +100 → over.
    const flatRes = budgetMonthly(rows, 1200, win, null)!;
    expect(flatRes.seasonal).toBe(false);
    const janFlat = flatRes.months[0];
    expect(janFlat.expected).toBeCloseTo(100, 10); // 1200 / 12
    expect(janFlat.cumProjected - janFlat.cumExpected).toBeCloseTo(100, 10);
    expect(janFlat.status).toBe('over');
  });

  it('actual sources billTotal (currentCharges), NEVER totalDueAmount; null when unbilled', () => {
    // A row with usage but NO billTotal contributes no actual even though it has kwh.
    const rows = [
      mkRow({ ym: 202401, billTotal: 200, kwh: 999 }),
      mkRow({ ym: 202402, billTotal: null, kwh: 12345 }), // unbilled → actual null
    ];
    const r = budgetMonthly(rows, 1200, win, seasonal)!;
    expect(r.months[0].actual).toBe(200);
    expect(r.months[1].actual).toBeNull(); // billTotal null wins over any usage
    // Bumping ONLY billTotal moves actual 1:1; nothing else on the row feeds it.
    const bumped = budgetMonthly(
      rows.map((x) => (x.ym === 202401 ? { ...x, billTotal: 275 } : x)),
      1200,
      win,
      seasonal
    )!;
    expect(bumped.months[0].actual! - r.months[0].actual!).toBe(75);
    expect(r.billsCounted).toBe(1);
    expect(r.totalActual).toBe(200);
  });

  it('ignores bills outside the window', () => {
    const rows = [
      mkRow({ ym: 202312, billTotal: 999 }), // prior Dec, out of window
      mkRow({ ym: 202501, billTotal: 999 }), // next Jan, out of window
      mkRow({ ym: 202403, billTotal: 150 }), // in window
    ];
    const r = budgetMonthly(rows, 1200, win, seasonal)!;
    expect(r.totalActual).toBe(150);
    expect(r.billsCounted).toBe(1);
    expect(r.months[2].actual).toBe(150); // Mar
  });

  it('cumulatives are correct running sums; projected uses actual then seasonal points', () => {
    // Jan 220, Feb 190 billed; Mar onward unbilled → projected = seasonal point.
    const rows = [
      mkRow({ ym: 202401, billTotal: 220 }),
      mkRow({ ym: 202402, billTotal: 190 }),
    ];
    const r = budgetMonthly(rows, 1200, win, seasonal)!;
    const [jan, feb, mar] = r.months;
    // cumActual: 220, then 410, then CARRIES 410 from Mar on (Mar has no new
    // actual, so the running actual-spend line flattens at the last billed total).
    expect(jan.cumActual).toBe(220);
    expect(feb.cumActual).toBe(410);
    expect(mar.cumActual).toBe(410); // carries last billed cumulative
    // projected: actual for billed months, seasonal projCost for future ones.
    expect(jan.projected).toBe(220);
    expect(feb.projected).toBe(190);
    expect(mar.projected).toBe(150); // Mar seasonal weight/point 150
    // cumProjected = 220 + 190 + 150 = 560 through Mar.
    expect(mar.cumProjected).toBeCloseTo(560, 10);
    // cumExpected through Mar = 200 + 200 + 150 = 550 (seasonal expected = weight).
    expect(mar.cumExpected).toBeCloseTo(550, 10);
    expect(mar.delta).toBeCloseTo(10, 10); // 560 − 550
    // Year-end cumProjected = 220 + 190 + (1200 − 200 − 200) seasonal rest
    //   = 410 + 800 = 1210. cumExpected year-end = 1200 (Σ weights).
    const dec = r.months[11];
    expect(dec.cumProjected).toBeCloseTo(1210, 8);
    expect(dec.cumExpected).toBeCloseTo(1200, 8);
  });

  it('status uses the ±tolerance band of the target (BUDGET_ON_TRACK_TOL)', () => {
    expect(BUDGET_ON_TRACK_TOL).toBe(0.02);
    // No actuals at all → projected each month = seasonal point = expected, so the
    // cumulative delta is ~0 everywhere → every month on_track.
    const r = budgetMonthly([], 1200, win, seasonal)!;
    expect(r.months.every((m) => m.status === 'on_track')).toBe(true);
    // A single in-window overage just under the tolerance stays on_track; over it
    // flips to over. tol = 2% × 1200 = 24.
    const within = budgetMonthly([mkRow({ ym: 202401, billTotal: 200 + 20 })], 1200, win, seasonal)!;
    expect(within.months[0].delta).toBeCloseTo(20, 10); // 220 − 200
    expect(within.months[0].status).toBe('on_track'); // 20 < 24
    const beyond = budgetMonthly([mkRow({ ym: 202401, billTotal: 200 + 30 })], 1200, win, seasonal)!;
    expect(beyond.months[0].delta).toBeCloseTo(30, 10); // 230 − 200
    expect(beyond.months[0].status).toBe('over'); // 30 > 24
  });

  it('falls back to a FLAT 1/N share when seasonal data is missing or partial', () => {
    // No seasonal at all.
    const none = budgetMonthly([], 1200, win, null)!;
    expect(none.seasonal).toBe(false);
    expect(none.months.every((m) => Math.abs(m.share - 1 / 12) < 1e-12)).toBe(true);
    expect(none.months[0].expected).toBeCloseTo(100, 10); // 1200/12

    // PARTIAL seasonal (only some calendar months) → still flat, because a fair
    // pace needs a weight for every window month.
    const partial = budgetMonthly([], 1200, win, [{ ym: 202501, projCost: 200 }])!;
    expect(partial.seasonal).toBe(false);
    expect(partial.months[0].expected).toBeCloseTo(100, 10);
  });
});
