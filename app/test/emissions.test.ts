import { describe, expect, it } from 'vitest';
import type { MonthRow } from '../src/lib/chartSpec';
import {
  EGRID_KG_CO2E_PER_KWH,
  GAS_KG_CO2E_PER_THERM,
  US_AVG_KG_CO2E_PER_KWH,
  estimateEmissions,
  resolveEmissionFactors,
  resolveGridFactor,
  trailing12Emissions,
  type EmissionFactors,
} from '../src/lib/emissions';

const mkRow = (over: Partial<MonthRow>): MonthRow => ({
  ym: 0, label: '', kwh: null, therms: null,
  elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
  elecBill: null, gasBill: null,
  elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
  avgTemp: null, billTotal: null, days: null,
  hdd: null, cdd: null, kwhPerDegreeDay: null, thermsPerHdd: null, ...over,
});

// Round factors so the test math is exact and hand-checkable.
const FACTORS: EmissionFactors = { elecKgPerKwh: 0.1308, gasKgPerTherm: 5.3 };

describe('resolveGridFactor (hand-checked lookup)', () => {
  it('maps NIAGARA_MOHAWK -> NYUP -> the documented eGRID factor', () => {
    expect(resolveGridFactor('NIAGARA_MOHAWK')).toBe(0.1308);
    expect(EGRID_KG_CO2E_PER_KWH.NYUP).toBe(0.1308);
  });

  it('falls back to the US average for an unknown region', () => {
    expect(resolveGridFactor('SOMEWHERE_ELSE')).toBe(US_AVG_KG_CO2E_PER_KWH);
    expect(resolveGridFactor(null)).toBe(US_AVG_KG_CO2E_PER_KWH);
  });

  it('honors a valid AppSetting override (green plan)', () => {
    expect(resolveGridFactor('NIAGARA_MOHAWK', '0')).toBe(0.1308); // <=0 ignored
    expect(resolveGridFactor('NIAGARA_MOHAWK', '0.05')).toBe(0.05); // override wins
    expect(resolveGridFactor(null, 'not-a-number')).toBe(US_AVG_KG_CO2E_PER_KWH); // junk ignored
  });

  it('resolveEmissionFactors pairs the grid factor with the EPA gas factor', () => {
    const f = resolveEmissionFactors('NIAGARA_MOHAWK');
    expect(f.elecKgPerKwh).toBe(0.1308);
    expect(f.gasKgPerTherm).toBe(GAS_KG_CO2E_PER_THERM);
    expect(f.gasKgPerTherm).toBe(5.3);
  });
});

describe('estimateEmissions (hand-calculated)', () => {
  it('co2e = usage × factor, per fuel + combined', () => {
    // 1000 kWh × 0.1308 = 130.8 kg; 50 therms × 5.3 = 265 kg; total 395.8 kg.
    const [r] = estimateEmissions([mkRow({ kwh: 1000, therms: 50 })], FACTORS);
    expect(r.co2eElec).toBeCloseTo(130.8, 10);
    expect(r.co2eGas).toBeCloseTo(265, 10);
    expect(r.co2eTotal).toBeCloseTo(395.8, 10);
  });

  it('a missing fuel leaves that fuel null; total = the present fuel', () => {
    const [elecOnly] = estimateEmissions([mkRow({ kwh: 2000, therms: null })], FACTORS);
    expect(elecOnly.co2eElec).toBeCloseTo(261.6, 10); // 2000 × 0.1308
    expect(elecOnly.co2eGas).toBeNull();
    expect(elecOnly.co2eTotal).toBeCloseTo(261.6, 10);

    const [gasOnly] = estimateEmissions([mkRow({ kwh: null, therms: 100 })], FACTORS);
    expect(gasOnly.co2eElec).toBeNull();
    expect(gasOnly.co2eGas).toBeCloseTo(530, 10); // 100 × 5.3
    expect(gasOnly.co2eTotal).toBeCloseTo(530, 10);
  });

  it('both fuels missing -> all null (no spurious 0)', () => {
    const [none] = estimateEmissions([mkRow({ kwh: null, therms: null })], FACTORS);
    expect(none.co2eElec).toBeNull();
    expect(none.co2eGas).toBeNull();
    expect(none.co2eTotal).toBeNull();
  });

  it('does not mutate the input rows or touch cost fields', () => {
    const input = mkRow({ kwh: 1000, therms: 50, billTotal: 147.5, elecBill: 100 });
    const [out] = estimateEmissions([input], FACTORS);
    expect(input.co2eTotal).toBeUndefined(); // input untouched
    expect(out.billTotal).toBe(147.5); // cost fields carried through unchanged
    expect(out.elecBill).toBe(100);
  });
});

describe('trailing12Emissions (hand-calculated)', () => {
  it('sums the most recent 12 estimated months, per fuel + combined + equivalences', () => {
    // 13 months, each: kwh 1000 (→130.8 kg elec), therms 50 (→265 kg gas).
    // Last 12 months: elec = 12×130.8 = 1569.6; gas = 12×265 = 3180;
    // total = 4749.6 kg.
    const rows = estimateEmissions(
      Array.from({ length: 13 }, (_, i) => mkRow({ ym: 202500 + i + 1, kwh: 1000, therms: 50 })),
      FACTORS
    );
    const s = trailing12Emissions(rows)!;
    expect(s.elecKg).toBeCloseTo(1569.6, 6);
    expect(s.gasKg).toBeCloseTo(3180, 6);
    expect(s.totalKg).toBeCloseTo(4749.6, 6);
    // 4749.6 / 8.887 = 534.45... gallons of gasoline.
    expect(s.gallonsGasoline).toBeCloseTo(4749.6 / 8.887, 6);
    // 4749.6 / 6 = 791.6 tree-years.
    expect(s.treeYears).toBeCloseTo(791.6, 6);
  });

  it('skips months with no combined estimate', () => {
    const rows = estimateEmissions(
      [mkRow({ kwh: null, therms: null }), mkRow({ kwh: 1000, therms: 50 })],
      FACTORS
    );
    const s = trailing12Emissions(rows)!;
    expect(s.totalKg).toBeCloseTo(395.8, 10); // only the one estimated month
  });

  it('returns null when nothing is estimable', () => {
    const rows = estimateEmissions([mkRow({ kwh: null, therms: null })], FACTORS);
    expect(trailing12Emissions(rows)).toBeNull();
  });
});
