// Hand-calculated unit tests for the degree-day usage regression + projection
// (issue #44). All PURE: no DB, no network, no React. The forecast/normals
// assembly is exercised by expectedDegreeDays.test.ts.
import { describe, expect, it } from 'vitest';
import {
  estimateNextBillFromDegreeDays,
  fitElectric,
  fitGas,
  fitObservations,
  fitUsageVsDegreeDays,
  MIN_FIT_ROWS_ELEC,
  MIN_FIT_ROWS_GAS,
  type FitObservation,
  type UsageFit,
} from '../src/lib/prediction';
import type { MonthRow } from '../src/lib/chartSpec';

const obs = (usage: number, hdd: number, cdd: number): FitObservation => ({ usage, hdd, cdd });

describe('fitGas — one-regressor OLS therms ≈ b + h·HDD (hand-calculated)', () => {
  it('recovers a known slope/intercept from a perfect line', () => {
    // HDD [0,10,20], therms [10,30,50]. mean HDD 10, mean therms 30.
    //   Shh = 100+0+100 = 200 ; Shy = (-10)(-20)+0+(10)(20) = 200+200 = 400
    //   slopeH = 400/200 = 2 ; base = 30 - 2*10 = 10. Perfect -> residualStdev 0.
    const fit = fitGas([obs(10, 0, 0), obs(30, 10, 0), obs(50, 20, 0)]);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.base).toBeCloseTo(10, 9);
    expect(fit.slopeH).toBeCloseTo(2, 9);
    expect(fit.slopeC).toBe(0); // gas has no cooling term
    expect(fit.residualStdev).toBeCloseTo(0, 9);
    expect(fit.n).toBe(3);
  });

  it('is insufficient below MIN_FIT_ROWS_GAS', () => {
    expect(MIN_FIT_ROWS_GAS).toBe(3);
    const fit = fitGas([obs(10, 0, 0), obs(30, 10, 0)]);
    expect(fit).toEqual({ ok: false, reason: 'insufficient' });
  });

  it('is degenerate when HDD has no variance (all equal)', () => {
    // Three rows, enough count, but identical HDD -> Shh = 0 -> non-invertible.
    const fit = fitGas([obs(10, 5, 0), obs(20, 5, 0), obs(30, 5, 0)]);
    expect(fit).toEqual({ ok: false, reason: 'degenerate' });
  });

  it('reports the residual standard error of an imperfect fit', () => {
    // therms [10,30,52] on HDD [0,10,20]. mean HDD 10, mean therms 30.667.
    //   Shh = 200 ; Shy = (-10)(10-30.667) + 0 + (10)(52-30.667)
    //       = (-10)(-20.667) + (10)(21.333) = 206.667 + 213.333 = 420
    //   slopeH = 420/200 = 2.1 ; base = 30.667 - 2.1*10 = 9.667
    //   fitted: 9.667, 30.667, 51.667 ; residuals: 0.333, -0.667, 0.333
    //   SS = 0.1111 + 0.4444 + 0.1111 = 0.6667 ; dof = 3-2 = 1
    //   residualStdev = sqrt(0.6667) = 0.8165
    const fit = fitGas([obs(10, 0, 0), obs(30, 10, 0), obs(52, 20, 0)]);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.slopeH).toBeCloseTo(2.1, 9);
    expect(fit.base).toBeCloseTo(9.6667, 4);
    expect(fit.residualStdev).toBeCloseTo(0.8165, 4);
  });
});

describe('fitElectric — two-regressor OLS kWh ≈ b + c·CDD + h·HDD (hand-calculated)', () => {
  it('recovers known coefficients from an orthogonal 2×2 grid', () => {
    // (CDD,HDD) grid (0,0),(0,10),(10,0),(10,10) -> centered CDD/HDD orthogonal
    // (Sch=0). True model kWh = 100 + 3*CDD + 2*HDD:
    //   (0,0)=100 (0,10)=120 (10,0)=130 (10,10)=150
    //   means CDD 5, HDD 5, ybar 125. Scc=100, Shh=100, Sch=0, det=10000.
    //   Scy=300 -> slopeC = 300*100/10000 = 3
    //   Shy=200 -> slopeH = 200*100/10000 = 2 ; base = 125 - 3*5 - 2*5 = 100.
    const fit = fitElectric([obs(100, 0, 0), obs(120, 10, 0), obs(130, 0, 10), obs(150, 10, 10)]);
    expect(fit.ok).toBe(true);
    if (!fit.ok) return;
    expect(fit.base).toBeCloseTo(100, 9);
    expect(fit.slopeC).toBeCloseTo(3, 9);
    expect(fit.slopeH).toBeCloseTo(2, 9);
    expect(fit.residualStdev).toBeCloseTo(0, 9); // perfect fit
    expect(fit.n).toBe(4);
  });

  it('is insufficient below MIN_FIT_ROWS_ELEC', () => {
    expect(MIN_FIT_ROWS_ELEC).toBe(4);
    const fit = fitElectric([obs(100, 0, 0), obs(120, 10, 0), obs(130, 0, 10)]);
    expect(fit).toEqual({ ok: false, reason: 'insufficient' });
  });

  it('is degenerate when degree-days carry no usable variance', () => {
    // All four rows share the same HDD and CDD -> centered matrix singular.
    const fit = fitElectric([obs(100, 5, 5), obs(120, 5, 5), obs(130, 5, 5), obs(150, 5, 5)]);
    expect(fit).toEqual({ ok: false, reason: 'degenerate' });
  });
});

describe('fitObservations / fitUsageVsDegreeDays (row plumbing)', () => {
  const mk = (p: Partial<MonthRow> & { ym: number }): MonthRow => ({
    ym: p.ym,
    label: '',
    kwh: p.kwh ?? null,
    therms: p.therms ?? null,
    elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
    elecBill: null, gasBill: null,
    elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
    avgTemp: null, billTotal: null,
    hdd: p.hdd ?? null, cdd: p.cdd ?? null, kwhPerDegreeDay: null, thermsPerHdd: null,
  });

  it('keeps only rows with the fuel usage AND degree-days', () => {
    const rows: MonthRow[] = [
      mk({ ym: 202401, kwh: 500, therms: 50, hdd: 100, cdd: 0 }), // both ok
      mk({ ym: 202402, kwh: 400, hdd: 80, cdd: 0 }), // gas usage missing
      mk({ ym: 202403, kwh: 300, therms: 30 }), // degree-days missing
    ];
    expect(fitObservations(rows, 'elec')).toEqual([
      { usage: 500, hdd: 100, cdd: 0 },
      { usage: 400, hdd: 80, cdd: 0 },
    ]);
    expect(fitObservations(rows, 'gas')).toEqual([{ usage: 50, hdd: 100, cdd: 0 }]);
  });

  it('fitUsageVsDegreeDays returns insufficient when there is no history', () => {
    const fits = fitUsageVsDegreeDays([]);
    expect(fits.elec).toEqual({ ok: false, reason: 'insufficient' });
    expect(fits.gas).toEqual({ ok: false, reason: 'insufficient' });
  });
});

describe('estimateNextBillFromDegreeDays — projection + pricing (hand-calculated)', () => {
  const elecFit: UsageFit = { ok: true, base: 100, slopeC: 3, slopeH: 2, residualStdev: 10, n: 12 };
  const gasFit: UsageFit = { ok: true, base: 10, slopeC: 0, slopeH: 2, residualStdev: 5, n: 12 };

  it('projects usage from expected DD, prices at all-in rates, bands in quadrature', () => {
    // expected HDD 30, CDD 20.
    //   elec usage = 100 + 3*20 + 2*30 = 220 ; cost = 220 * 0.20 = 44 ; half = 1*10*0.20 = 2
    //   gas  usage = 10 + 2*30 = 70 ; cost = 70 * 1.00 = 70 ; half = 1*5*1.00 = 5
    //   point = 44 + 70 = 114 ; half = sqrt(2^2 + 5^2) = sqrt(29) = 5.3852
    //   low = 114 - 5.3852 = 108.6148 ; high = 119.3852
    const est = estimateNextBillFromDegreeDays({
      elecFit,
      gasFit,
      expected: { hdd: 30, cdd: 20, forecastDays: 11, normalDays: 19 },
      elecRate: 0.2,
      gasRate: 1.0,
    });
    expect(est).not.toBeNull();
    expect(est!.point).toBeCloseTo(114, 9);
    expect(est!.low).toBeCloseTo(108.6148, 4);
    expect(est!.high).toBeCloseTo(119.3852, 4);
    expect(est!.basis).toContain('forecast for 11 days + normals for 19 days');
    expect(est!.basis).toContain('electric HDD+CDD fit');
    expect(est!.basis).toContain('gas HDD fit');
    expect(est!.basis).toContain('±1σ regression residual');
  });

  it('floors a negative projected usage at 0', () => {
    // A warm window with a heavy positive HDD slope but tiny base could project
    // negative; we floor usage at 0 so cost never goes negative.
    const coldFit: UsageFit = { ok: true, base: -50, slopeC: 0, slopeH: 1, residualStdev: 0, n: 12 };
    const est = estimateNextBillFromDegreeDays({
      elecFit: { ok: false, reason: 'degenerate' },
      gasFit: coldFit,
      expected: { hdd: 10, cdd: 0, forecastDays: 0, normalDays: 30 }, // 10*1 - 50 = -40 -> 0
      elecRate: null,
      gasRate: 1.0,
    });
    expect(est).not.toBeNull();
    expect(est!.point).toBeCloseTo(0, 9);
    // No forecast days -> "normals-only" caption.
    expect(est!.basis).toContain('30-day window from climatological normals');
  });

  it('drops a fuel it cannot fit or price, keeping the other', () => {
    const est = estimateNextBillFromDegreeDays({
      elecFit, // ok
      gasFit, // ok but no rate
      expected: { hdd: 30, cdd: 20, forecastDays: 0, normalDays: 30 },
      elecRate: 0.2,
      gasRate: null, // can't price gas -> electric only
    });
    expect(est).not.toBeNull();
    expect(est!.point).toBeCloseTo(44, 9); // electric only
    expect(est!.basis).toContain('electric HDD+CDD fit');
    expect(est!.basis).not.toContain('gas HDD fit');
  });

  it('returns null when neither fuel can be both fit and priced', () => {
    const est = estimateNextBillFromDegreeDays({
      elecFit: { ok: false, reason: 'insufficient' },
      gasFit, // ok but no rate
      expected: { hdd: 30, cdd: 20, forecastDays: 0, normalDays: 30 },
      elecRate: 0.2, // elec priced but not fit
      gasRate: null, // gas fit but not priced
    });
    expect(est).toBeNull();
  });

  it('uses the ±15% fallback band when both residual spreads are 0', () => {
    // Perfect fits (residualStdev 0) would collapse the band to a single point;
    // we floor it to ±15% so the range stays meaningful.
    const flat: UsageFit = { ok: true, base: 100, slopeC: 0, slopeH: 0, residualStdev: 0, n: 12 };
    const est = estimateNextBillFromDegreeDays({
      elecFit: flat, // usage 100, cost 100*0.2 = 20
      gasFit: { ok: false, reason: 'degenerate' },
      expected: { hdd: 0, cdd: 0, forecastDays: 0, normalDays: 30 },
      elecRate: 0.2,
      gasRate: null,
    });
    expect(est).not.toBeNull();
    expect(est!.point).toBeCloseTo(20, 9);
    expect(est!.low).toBeCloseTo(17, 9); // 20 - 0.15*20
    expect(est!.high).toBeCloseTo(23, 9);
    expect(est!.basis).toContain('±15%');
  });
});
