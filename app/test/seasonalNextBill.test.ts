// Hand-calculated unit tests for the seasonal next-bill estimate (issue #67).
// All PURE: no DB, no network, no React. We construct tiny synthetic datasets
// whose component-rate decomposition, weather-aware usage projection, walk-forward
// bias correction and band can each be hand-computed exactly, then assert them.
import { describe, expect, it } from 'vitest';
import {
  estimateNextBill,
  estimateNextBillSeasonal,
  fitComponentRate,
  kalmanComponentRate,
  trailingResiduals,
  type ComponentPick,
  type ExpectedDegreeDays,
} from '../src/lib/prediction';
import type { MonthRow } from '../src/lib/chartSpec';

// Minimal MonthRow builder — only the fields the #67 model reads.
const mk = (p: Partial<MonthRow> & { ym: number }): MonthRow => ({
  ym: p.ym,
  label: '',
  kwh: p.kwh ?? null,
  therms: p.therms ?? null,
  elecSupply: p.elecSupply ?? null,
  gasSupply: p.gasSupply ?? null,
  elecDelivery: p.elecDelivery ?? null,
  gasDelivery: p.gasDelivery ?? null,
  elecBill: p.elecBill ?? null, gasBill: p.gasBill ?? null,
  elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
  avgTemp: null, billTotal: p.billTotal ?? null, days: p.days ?? null,
  hdd: p.hdd ?? null, cdd: p.cdd ?? null, kwhPerDegreeDay: null, thermsPerHdd: null,
});

describe('fitComponentRate — 2-param fixed/day + variable/unit decomposition (hand-calculated)', () => {
  it('recovers a known fixed and rate from perfectly linear data', () => {
    // amount = 2·days + 0.5·therms exactly. Three rows -> exact 2-param OLS fit.
    //   A: days 30, therms 10 -> 60 + 5  = 65
    //   B: days 30, therms 0  -> 60 + 0  = 60
    //   C: days 31, therms 20 -> 62 + 10 = 72
    const pick: ComponentPick = { usage: 'therms', comp: 'gasDelivery' };
    const rows: MonthRow[] = [
      mk({ ym: 202401, therms: 10, days: 30, gasDelivery: 65 }),
      mk({ ym: 202402, therms: 0, days: 30, gasDelivery: 60 }),
      mk({ ym: 202403, therms: 20, days: 31, gasDelivery: 72 }),
    ];
    const cr = fitComponentRate(rows, pick);
    expect(cr).not.toBeNull();
    expect(cr!.fixedPerDay).toBeCloseTo(2, 6);
    expect(cr!.rate).toBeCloseTo(0.5, 6);
  });

  it('falls back to mean $/unit when the regression slope goes negative', () => {
    // amount = 120 - 3·therms (a NEGATIVE usage slope) -> OLS rate < 0 -> fallback.
    // days 30 each. (therms, amount): (10,90),(20,60),(30,30).
    //   fallback rate  = ΣAmt / ΣUse = 180 / 60 = 3.0
    //   fallback fixed = (ΣAmt - rate·ΣUse) / Σdays = (180 - 3·60)/90 = 0
    const pick: ComponentPick = { usage: 'therms', comp: 'gasDelivery' };
    const rows: MonthRow[] = [
      mk({ ym: 202401, therms: 10, days: 30, gasDelivery: 90 }),
      mk({ ym: 202402, therms: 20, days: 30, gasDelivery: 60 }),
      mk({ ym: 202403, therms: 30, days: 30, gasDelivery: 30 }),
    ];
    const cr = fitComponentRate(rows, pick);
    expect(cr).not.toBeNull();
    expect(cr!.rate).toBeCloseTo(3.0, 6);
    expect(cr!.fixedPerDay).toBeCloseTo(0, 6);
  });

  it('returns null with fewer than three usable bills', () => {
    const pick: ComponentPick = { usage: 'kwh', comp: 'elecSupply' };
    const rows: MonthRow[] = [
      mk({ ym: 202401, kwh: 100, days: 30, elecSupply: 50 }),
      mk({ ym: 202402, kwh: 200, days: 30, elecSupply: 70 }),
    ];
    expect(fitComponentRate(rows, pick)).toBeNull();
  });

  it('skips rows missing a period length (days)', () => {
    // Same linear data as the first case but with a no-days row interleaved that
    // must be ignored, leaving exactly the three usable rows.
    const pick: ComponentPick = { usage: 'therms', comp: 'gasDelivery' };
    const rows: MonthRow[] = [
      mk({ ym: 202401, therms: 10, days: 30, gasDelivery: 65 }),
      mk({ ym: 202402, therms: 999, days: null, gasDelivery: 9999 }), // no days -> skipped
      mk({ ym: 202403, therms: 0, days: 30, gasDelivery: 60 }),
      mk({ ym: 202404, therms: 20, days: 31, gasDelivery: 72 }),
    ];
    const cr = fitComponentRate(rows, pick);
    expect(cr!.fixedPerDay).toBeCloseTo(2, 6);
    expect(cr!.rate).toBeCloseTo(0.5, 6);
  });
});

describe('kalmanComponentRate — random-walk filtered fixed/day + variable/unit (hand-calculated)', () => {
  const pick: ComponentPick = { usage: 'therms', comp: 'gasDelivery' };

  it('stays at the true state when every bill is exactly consistent with it', () => {
    // Eight bills all on amount = 2·days + 0.5·therms (days 30). The OLS init on
    // the first four recovers (2, 0.5) exactly; the filter, fed observations
    // perfectly consistent with that state, neither drifts nor is corrected —
    // it returns the true (fixed, rate) to machine precision.
    const therms = [10, 0, 20, 5, 15, 8, 12, 18];
    const rows: MonthRow[] = therms.map((t, i) =>
      mk({ ym: 202401 + i, therms: t, days: 30, gasDelivery: 2 * 30 + 0.5 * t })
    );
    const cr = kalmanComponentRate(rows, pick);
    expect(cr).not.toBeNull();
    expect(cr!.fixedPerDay).toBeCloseTo(2, 6);
    expect(cr!.rate).toBeCloseTo(0.5, 6);
  });

  it('tracks a drifting rate, pulling the estimate toward the newer observations', () => {
    // First four bills price at rate 0.5/therm, the next four at 1.0/therm (a
    // step up). The init OLS seeds rate=0.5; consuming the higher-rate bills the
    // filter pulls the estimate UP toward 1.0 but, with finite process noise,
    // stops short of it — strictly between the old and new rate.
    const rows: MonthRow[] = [];
    [10, 20, 5, 15].forEach((t, i) =>
      rows.push(mk({ ym: 202401 + i, therms: t, days: 30, gasDelivery: 2 * 30 + 0.5 * t }))
    );
    [10, 20, 5, 15].forEach((t, i) =>
      rows.push(mk({ ym: 202405 + i, therms: t, days: 30, gasDelivery: 2 * 30 + 1.0 * t }))
    );
    const cr = kalmanComponentRate(rows, pick)!;
    expect(cr.rate).toBeGreaterThan(0.5);
    expect(cr.rate).toBeLessThan(1.0);
  });

  it('falls back to the initial OLS (here a mean $/unit) on a degenerate fit', () => {
    // Three bills (< KALMAN_INIT_BILLS) on a NEGATIVE usage slope -> the OLS init
    // is degenerate (rate < 0) so fitComponentRate returns the mean-$/unit
    // fallback, and the filter doesn't run (too few bills). Matches the POC's
    // _init_ols-only path for short components. (therms,amount): (10,90),(20,60),
    // (30,30) at days 30 -> rate = ΣAmt/ΣUse = 180/60 = 3, fixed = 0.
    const rows: MonthRow[] = [
      mk({ ym: 202401, therms: 10, days: 30, gasDelivery: 90 }),
      mk({ ym: 202402, therms: 20, days: 30, gasDelivery: 60 }),
      mk({ ym: 202403, therms: 30, days: 30, gasDelivery: 30 }),
    ];
    const cr = kalmanComponentRate(rows, pick);
    expect(cr).not.toBeNull();
    expect(cr!.rate).toBeCloseTo(3.0, 6);
    expect(cr!.fixedPerDay).toBeCloseTo(0, 6);
  });

  it('returns null with fewer than three usable bills', () => {
    const rows: MonthRow[] = [
      mk({ ym: 202401, therms: 10, days: 30, gasDelivery: 90 }),
      mk({ ym: 202402, therms: 20, days: 30, gasDelivery: 60 }),
    ];
    expect(kalmanComponentRate(rows, pick)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// A controlled 24-bill synthetic account for the full-model + band tests.
//
// Electric usage lies EXACTLY on the plane  kwh = 100 + 3·CDD + 2·HDD  on the
// orthogonal (CDD,HDD) grid (0,0),(0,10),(10,0),(10,10) -> kwh 100/120/130/150.
//   fitElectric recovers base 100, slopeC 3, slopeH 2 (residualStdev 0).
// Gas usage lies on  therms = 50 + 1·HDD  -> 50 when HDD 0, 60 when HDD 10.
//   fitGas recovers base 50, slopeH 1.
//
// Days = 30 for every bill. The four components are priced EXACTLY as
// fixed·days + rate·usage:
//   elecSupply   : 1.0·days + 0.10·kwh
//   elecDelivery : 0.5·days + 0.05·kwh
//   gasSupply    : 0.3·days + 0.40·therms
//   gasDelivery  : 2.0·days + 0.20·therms
// so each component's 2-param fit recovers its (fixed, rate) exactly, and the raw
// model bill = 114 + 0.15·kwh + 0.60·therms (fixed total 3.8/day·30 = 114).
//
// Per grid point the raw bill is:  A 159, B 168, C 163.5, D 172.5.
//
// billTotal carries a per-bill OFFSET δ on top of the raw bill, so the
// walk-forward residual (actual − raw) is exactly δ. Rows 0..17 use δ=0; the last
// six (the ones the walk-forward back-tests, i=18..23) use δ = 3,4,5,6,7,8.
// ---------------------------------------------------------------------------

const GRID = [
  { cdd: 0, hdd: 0 }, // A
  { cdd: 0, hdd: 10 }, // B
  { cdd: 10, hdd: 0 }, // C
  { cdd: 10, hdd: 10 }, // D
];
const rawBill = (kwh: number, therms: number) => 114 + 0.15 * kwh + 0.6 * therms;

function buildAccount(): MonthRow[] {
  const rows: MonthRow[] = [];
  for (let i = 0; i < 24; i++) {
    const g = GRID[i % 4];
    const kwh = 100 + 3 * g.cdd + 2 * g.hdd;
    const therms = 50 + 1 * g.hdd;
    const raw = rawBill(kwh, therms);
    const delta = i >= 18 ? i - 15 : 0; // i=18->3, 19->4, ... 23->8
    rows.push(
      mk({
        ym: 202200 + i + 1, // arbitrary monotonically increasing yms
        kwh,
        therms,
        days: 30,
        hdd: g.hdd,
        cdd: g.cdd,
        elecSupply: 1.0 * 30 + 0.1 * kwh,
        elecDelivery: 0.5 * 30 + 0.05 * kwh,
        gasSupply: 0.3 * 30 + 0.4 * therms,
        gasDelivery: 2.0 * 30 + 0.2 * therms,
        billTotal: raw + delta,
      })
    );
  }
  return rows;
}

describe('trailingResiduals — walk-forward (actual − raw), no leakage (hand-calculated)', () => {
  it('returns one residual per back-tested bill, equal to its offset δ', () => {
    // 24 usable bills -> walk-forward i = 18..23 -> 6 residuals = the offsets δ.
    const resid = trailingResiduals(buildAccount());
    expect(resid).toHaveLength(6);
    expect(resid.map((r) => Math.round(r * 1e6) / 1e6)).toEqual([3, 4, 5, 6, 7, 8]);
  });
});

describe('estimateNextBillSeasonal — full model (hand-calculated)', () => {
  const rows = buildAccount();
  // Target window: HDD 10, CDD 10, 30 days.
  //   kwh    = 100 + 3·10 + 2·10 = 150
  //   therms = 50  + 1·10        = 60
  //   raw    = 114 + 0.15·150 + 0.60·60 = 114 + 22.5 + 36 = 172.5
  const target: ExpectedDegreeDays = { hdd: 10, cdd: 10, forecastDays: 0, normalDays: 30 };

  it('prices weather-normal usage with the Kalman component rates and NO bias term', () => {
    // Every bill lies EXACTLY on its component's fixed·days + rate·usage model, so
    // each component's OLS init is exact and the Kalman filter — fed observations
    // perfectly consistent with that state — stays there. The point is therefore
    // the raw bill 172.5 with no bias correction added (the Kalman path drops it).
    const est = estimateNextBillSeasonal(rows, { target, targetDays: 30 });
    expect(est).not.toBeNull();
    expect(est!.point).toBeCloseTo(172.5, 4);
  });

  it('bands by ±1σ of the walk-forward residuals', () => {
    // Residuals are the per-bill offsets δ = [3,4,5,6,7,8] (the Kalman model
    // reproduces each exact raw bill, so actual − model = δ).
    // σ (sample, n-1): mean 5.5, SS 17.5, var 3.5, σ = √3.5 ≈ 1.870829
    const est = estimateNextBillSeasonal(rows, { target, targetDays: 30 })!;
    const sigma = Math.sqrt(3.5);
    expect(est.high - est.point).toBeCloseTo(sigma, 6);
    expect(est.low).toBeCloseTo(est.point - sigma, 6);
    expect(est.high).toBeCloseTo(est.point + sigma, 6);
    expect(est.basis).toContain('Kalman-filtered fixed+variable rates');
    expect(est.basis).toContain('back-test residuals');
  });
});

describe('estimateNextBillSeasonal — fallback to the #9 calendar estimate', () => {
  const target: ExpectedDegreeDays = { hdd: 10, cdd: 10, forecastDays: 0, normalDays: 30 };

  it('returns null with too few usable bills (< 18) so the caller uses #9', () => {
    const rows = buildAccount().slice(0, 17); // only 17 usable bills
    expect(estimateNextBillSeasonal(rows, { target, targetDays: 30 })).toBeNull();
  });

  it('returns null when no target-window degree-days are supplied', () => {
    expect(estimateNextBillSeasonal(buildAccount(), {})).toBeNull();
    expect(estimateNextBillSeasonal(buildAccount())).toBeNull();
  });

  it('the wired expression (seasonal ?? #9) yields the #9 result on the fallback path', () => {
    // A short history that #67 refuses (too few bills) but #9 can still estimate
    // from. 13 monthly rows ending 2026-05; same-month-last-year (2025-06) usage
    // priced at the trailing-12 all-in rate is the #9 number. We just assert the
    // wired expression returns exactly what estimateNextBill returns here.
    const r = (ym: number, kwh: number, therms: number, billTotal: number): MonthRow =>
      mk({ ym, kwh, therms, elecBill: kwh * 0.2, gasBill: therms * 1.0, billTotal });
    const short: MonthRow[] = [
      r(202505, 500, 50, 100), r(202506, 600, 40, 100), r(202507, 700, 10, 100),
      r(202508, 700, 5, 100), r(202509, 650, 8, 100), r(202510, 600, 20, 100),
      r(202511, 550, 60, 100), r(202512, 520, 90, 100), r(202601, 540, 100, 100),
      r(202602, 530, 95, 100), r(202603, 560, 70, 150), r(202604, 580, 45, 160),
      r(202605, 610, 30, 170),
    ];
    const wired = estimateNextBillSeasonal(short, { target, targetDays: 30 }) ?? estimateNextBill(short);
    const nine = estimateNextBill(short);
    expect(nine).not.toBeNull();
    expect(wired).toEqual(nine);
  });
});
