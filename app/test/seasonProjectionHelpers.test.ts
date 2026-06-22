// Hand-calculated unit tests for the pure helpers extracted from projectSeason
// (issue #158): resolvePricingMode, priceSeasonMonth, combineAnnualBand. The
// decomposition is behavior-preserving — seasonProjection.test.ts proves the
// composed projectSeason() output is unchanged; these tests pin each extracted
// piece independently with hand-worked expected values. All PURE: no DB / network
// / React.
import { describe, expect, it } from 'vitest';
import {
  combineAnnualBand,
  fitUsageVsDegreeDays,
  priceSeasonMonth,
  resolvePricingMode,
  type ExpectedDegreeDays,
  type PricingMode,
  type SeasonMonth,
} from '../src/lib/prediction';
import type { MonthRow } from '../src/lib/chartSpec';

// Minimal MonthRow builder — only the fields the helpers read.
const mk = (p: Partial<MonthRow> & { ym: number }): MonthRow => ({
  ym: p.ym,
  label: '',
  kwh: p.kwh ?? null,
  therms: p.therms ?? null,
  elecSupply: p.elecSupply ?? null, gasSupply: p.gasSupply ?? null,
  elecDelivery: p.elecDelivery ?? null, gasDelivery: p.gasDelivery ?? null,
  elecBill: p.elecBill ?? null, gasBill: p.gasBill ?? null,
  elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
  avgTemp: null, billTotal: p.billTotal ?? null, days: p.days ?? null,
  hdd: p.hdd ?? null, cdd: p.cdd ?? null, kwhPerDegreeDay: null, thermsPerHdd: null,
});

describe('resolvePricingMode (issue #158 extraction)', () => {
  it('flat mode (sparse history): useComponents false, var rates 0, days = median', () => {
    // Four rows, well under MIN_SEASONAL_BILLS -> Kalman component fit can't be
    // trusted, so useComponents is false regardless of full component data.
    // days = [28,30,30,32] -> sorted median of the two central (30,30) = 30.
    const rows: MonthRow[] = [
      mk({ ym: 202401, kwh: 100, therms: 10, days: 28, elecSupply: 6, elecDelivery: 4, gasSupply: 3, gasDelivery: 7 }),
      mk({ ym: 202402, kwh: 100, therms: 10, days: 30, elecSupply: 6, elecDelivery: 4, gasSupply: 3, gasDelivery: 7 }),
      mk({ ym: 202403, kwh: 100, therms: 10, days: 30, elecSupply: 6, elecDelivery: 4, gasSupply: 3, gasDelivery: 7 }),
      mk({ ym: 202404, kwh: 100, therms: 10, days: 32, elecSupply: 6, elecDelivery: 4, gasSupply: 3, gasDelivery: 7 }),
    ];
    const mode = resolvePricingMode(rows);
    expect(mode.useComponents).toBe(false);
    expect(mode.elecVarRate).toBe(0);
    expect(mode.gasVarRate).toBe(0);
    expect(mode.days).toBe(30);
  });

  it('no day values -> days falls back to 30', () => {
    const rows: MonthRow[] = [mk({ ym: 202401, kwh: 100 }), mk({ ym: 202402, kwh: 110 })];
    const mode = resolvePricingMode(rows);
    expect(mode.days).toBe(30);
    expect(mode.useComponents).toBe(false);
  });

  it('component mode: useComponents true, var rates = supply+delivery $/unit, days = median', () => {
    // 24 perfectly-linear bills (>= MIN_SEASONAL_BILLS) — same construction as the
    // existing projectSeason component test. The Kalman filter recovers the exact
    // constant rates, so the per-fuel variable rate is the sum of supply+delivery:
    //   elec var = ES_R + ED_R = 0.08 + 0.05 = 0.13
    //   gas  var = GS_R + GD_R = 0.40 + 0.30 = 0.70
    // days vary 28,29,30,31 repeating six times -> median of central (29,30) = 29.5.
    const ES_F = 0.1, ES_R = 0.08, ED_F = 0.2, ED_R = 0.05;
    const GS_F = 0.15, GS_R = 0.4, GD_F = 0.5, GD_R = 0.3;
    const N = 24;
    const built: MonthRow[] = Array.from({ length: N }, (_, i) => {
      const ym = 202401 + (i < 12 ? i : 100 + (i - 12));
      const hdd = (i % 6) * 10;
      const cdd = ((i + 3) % 6) * 5;
      const days = 28 + (i % 4);
      const kwh = 100 + 3 * cdd + 1 * hdd;
      const therms = 2 * hdd;
      const elecSupply = ES_F * days + ES_R * kwh;
      const elecDelivery = ED_F * days + ED_R * kwh;
      const gasSupply = GS_F * days + GS_R * therms;
      const gasDelivery = GD_F * days + GD_R * therms;
      return mk({
        ym, kwh, therms, hdd, cdd, days,
        elecSupply, elecDelivery, gasSupply, gasDelivery,
        elecBill: elecSupply + elecDelivery, gasBill: gasSupply + gasDelivery,
        billTotal: elecSupply + elecDelivery + gasSupply + gasDelivery,
      });
    });
    const mode = resolvePricingMode(built);
    expect(mode.useComponents).toBe(true);
    expect(mode.days).toBeCloseTo(29.5, 9);
    expect(mode.elecVarRate).toBeCloseTo(0.13, 6);
    expect(mode.gasVarRate).toBeCloseTo(0.7, 6);
    // The four component rates are all present and recover their construction.
    expect(mode.es!.rate).toBeCloseTo(ES_R, 6);
    expect(mode.ed!.fixedPerDay).toBeCloseTo(ED_F, 6);
  });
});

describe('priceSeasonMonth (issue #158 extraction)', () => {
  // FOUR electric rows on the orthogonal (CDD,HDD) grid (0,0),(0,10),(10,0),(10,10)
  // with kwh = [101,119,130,150]: recovers base 100.5, slopeC 3, slopeH 1.9,
  // residualStdev 1.0 (worked in seasonProjection.test.ts). No gas.
  const rows: MonthRow[] = [
    mk({ ym: 202401, kwh: 101, cdd: 0, hdd: 0, elecBill: 20.2 }),
    mk({ ym: 202402, kwh: 119, cdd: 0, hdd: 10, elecBill: 23.8 }),
    mk({ ym: 202403, kwh: 130, cdd: 10, hdd: 0, elecBill: 26 }),
    mk({ ym: 202404, kwh: 150, cdd: 10, hdd: 10, elecBill: 30 }),
  ];
  const fits = fitUsageVsDegreeDays(rows);
  // Flat-mode pricing mode for elec 0.20, gas null (sparse history -> flat).
  const flatMode = resolvePricingMode(rows);

  it('flat fit-path month: usage from fit, cost at flat rate, band = k·σ·sqrt(h)·rate', () => {
    expect(flatMode.useComponents).toBe(false);
    // normals HDD 30, CDD 20 -> usage = 100.5 + 3·20 + 1.9·30 = 217.5.
    const normals: ExpectedDegreeDays = { hdd: 30, cdd: 20, forecastDays: 0, normalDays: 30 };
    // h=4: cost = 217.5·0.20 = 43.5 ; baseHalf = 1·1.0 = 1.0 (kWh) ; in $ = 0.20 ;
    //   half = 0.20·sqrt(4) = 0.40 ; gas dropped (no rate) -> projTherms null.
    const res = priceSeasonMonth(rows, 202408, 4, fits, normals, flatMode, { elec: 0.2, gas: null }, 1);
    expect(res.month.ym).toBe(202408);
    expect(res.month.projKwh).toBeCloseTo(217.5, 6);
    expect(res.month.projTherms).toBeNull();
    expect(res.month.projCost).toBeCloseTo(43.5, 6);
    expect(res.month.high - res.month.projCost).toBeCloseTo(0.4, 6); // sqrt(4)=2
    expect(res.month.low).toBeCloseTo(43.1, 6);
    expect(res.anyFit).toBe(true);
    expect(res.usedFallback).toBe(false);
    expect(res.month.fallback).toBe(false);
  });

  it('fallback month: same-month-last-year usage at flat rate, ±15% floor band, fallback flagged', () => {
    // 13 monthly rows with usage but NO degree-days -> fit insufficient. With an
    // undefined normals lookup the month falls back to same-month-last-year.
    // elecBill = 0.10·kwh, gasBill = 1·therms.
    const yms = [
      202301, 202302, 202303, 202304, 202305, 202306,
      202307, 202308, 202309, 202310, 202311, 202312, 202401,
    ];
    const built: MonthRow[] = yms.map((ym, i) =>
      mk({ ym, kwh: 100 + i, therms: 10 + i, elecBill: (100 + i) * 0.1, gasBill: (10 + i) * 1 })
    );
    const fb = fitUsageVsDegreeDays(built);
    const mode = resolvePricingMode(built); // flat (no component data)
    // First projected month is 202402; same-month-last-year 202302 -> kwh 101,
    // therms 11. cost = 101·0.10 + 11·1.00 = 10.1 + 11 = 21.1. baseHalf=0 for a
    // fallback -> half collapses, so the ±15% floor applies: 0.15·21.1 = 3.165.
    const res = priceSeasonMonth(built, 202402, 1, fb, undefined, mode, { elec: 0.1, gas: 1.0 }, 1);
    expect(res.month.projKwh).toBeCloseTo(101, 6);
    expect(res.month.projTherms).toBeCloseTo(11, 6);
    expect(res.month.projCost).toBeCloseTo(21.1, 6);
    expect(res.month.high - res.month.projCost).toBeCloseTo(3.165, 6); // ±15% floor
    expect(res.month.low).toBeCloseTo(21.1 - 3.165, 6);
    expect(res.usedFallback).toBe(true);
    expect(res.month.fallback).toBe(true);
    expect(res.anyFit).toBe(false);
  });

  it('component mode: fixed charge accrues at ~0 usage; band uses variable rate', () => {
    // Synthetic component mode (no Kalman dependency): assert the helper applies
    // the (fixed·days + var·usage) formula and converts the band via the variable
    // rate. Single fit-path month, elec only.
    const mode: PricingMode = {
      useComponents: true,
      es: { fixedPerDay: 0.1, rate: 0.08 },
      ed: { fixedPerDay: 0.2, rate: 0.05 },
      gs: { fixedPerDay: 0.15, rate: 0.4 },
      gd: { fixedPerDay: 0.5, rate: 0.3 },
      elecVarRate: 0.13, // 0.08 + 0.05
      gasVarRate: 0.7,   // 0.40 + 0.30
      days: 30,
    };
    // normals HDD 0, CDD 20 -> elec usage = 100.5 + 3·20 + 1.9·0 = 160.5 ;
    //   elecCost = (0.1+0.2)·30 + 0.13·160.5 = 9 + 20.865 = 29.865.
    // Gas: no gas usage in `rows` -> gas fit insufficient AND no same-month-last
    //   -year -> gas drops to 0. So gasCost = 0 (NOT fixed: there is no gas value).
    //   projCost = 29.865.
    const normals: ExpectedDegreeDays = { hdd: 0, cdd: 20, forecastDays: 0, normalDays: 30 };
    const res = priceSeasonMonth(rows, 202405, 1, fits, normals, mode, { elec: null, gas: null }, 1);
    expect(res.month.projKwh).toBeCloseTo(160.5, 6);
    expect(res.month.projTherms).toBeNull();
    expect(res.month.projCost).toBeCloseTo(29.865, 6);
    // band: baseHalf 1.0 (kWh) -> $ via elecVarRate 0.13, sqrt(1)=1 -> 0.13.
    expect(res.month.high - res.month.projCost).toBeCloseTo(0.13, 6);
  });
});

describe('combineAnnualBand (issue #158 extraction)', () => {
  const m = (projCost: number, high: number): SeasonMonth => ({
    ym: 0, label: '', projKwh: null, projTherms: null, projCost, low: 0, high, fallback: false,
  });

  it('sums points and combines half-widths in quadrature', () => {
    // Two months: points 10 (half 3) and 20 (half 4). point = 30 ;
    // annualHalf = sqrt(3² + 4²) = sqrt(25) = 5. low = 25, high = 35.
    const months = [m(10, 13), m(20, 24)];
    const annual = combineAnnualBand(months);
    expect(annual.point).toBe(30);
    expect(annual.high - annual.point).toBeCloseTo(5, 9);
    expect(annual.low).toBeCloseTo(25, 9);
    expect(annual.high).toBeCloseTo(35, 9);
  });

  it('matches the 12-equal-month quadrature: half(h)=c·sqrt(h) -> annual = c·sqrt(Σh)', () => {
    // 12 months each projCost 43.5 with half(h) = 0.20·sqrt(h) (the existing
    // seasonProjection fit-path case). point = 12·43.5 = 522 ;
    // annualHalf = sqrt(Σ (0.20·sqrt(h))²) = 0.20·sqrt(1+2+…+12) = 0.20·sqrt(78)
    //            = 1.766352.
    const months = Array.from({ length: 12 }, (_, i) => {
      const h = i + 1;
      const half = 0.2 * Math.sqrt(h);
      return m(43.5, 43.5 + half);
    });
    const annual = combineAnnualBand(months);
    expect(annual.point).toBeCloseTo(522, 9);
    expect(annual.high - annual.point).toBeCloseTo(1.766352, 5);
    expect(annual.low).toBeCloseTo(520.233648, 5);
  });

  it('±15% floor when every monthly half-width is 0', () => {
    // All halves 0 -> annualHalf collapses to 0 -> floor 0.15·point.
    // point = 100 -> annualHalf = 15 -> low 85, high 115.
    const months = [m(40, 40), m(60, 60)];
    const annual = combineAnnualBand(months);
    expect(annual.point).toBe(100);
    expect(annual.high - annual.point).toBeCloseTo(15, 9);
    expect(annual.low).toBeCloseTo(85, 9);
  });

  it('empty months -> point 0, half floor 0', () => {
    const annual = combineAnnualBand([]);
    expect(annual).toEqual({ point: 0, low: 0, high: 0 });
  });
});
