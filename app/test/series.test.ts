import { describe, expect, it } from 'vitest';
import type { MonthRow } from '../src/lib/chartSpec';
import { deriveMonthlySeries, trailing12AllIn } from '../src/lib/series';

describe('deriveMonthlySeries (hand-calculated)', () => {
  const rows = deriveMonthlySeries({
    usages: [
      { periodYearMonth: 202601, usageType: 'TOTAL_KWH', quantity: 500 },
      { periodYearMonth: 202601, usageType: 'THERMS', quantity: 50 },
    ],
    costs: [
      { periodYearMonth: 202601, fuelType: 'ELECTRIC', kind: 'SUPPLY', amount: 40 },
      { periodYearMonth: 202601, fuelType: 'ELECTRIC', kind: 'DELIVERY', amount: 60 },
      { periodYearMonth: 202601, fuelType: 'GAS', kind: 'SUPPLY', amount: 20 },
      { periodYearMonth: 202601, fuelType: 'GAS', kind: 'DELIVERY', amount: 30 },
    ],
    weather: [{ ym: 202601, avgTemperature: 25 }],
    bills: [{ ym: 202601, currentCharges: 147.5 }],
    // A 31-day Jan period worth of degree-days, summed by the caller.
    degreeDays: [{ ym: 202601, hdd: 1000, cdd: 250 }],
  });
  const r = rows[0];

  it('aggregates a single month correctly', () => {
    expect(rows).toHaveLength(1);
    expect(r.label).toBe('2026-01');
    expect(r.kwh).toBe(500);
    expect(r.therms).toBe(50);
    expect(r.elecSupply).toBe(40);
    expect(r.elecDelivery).toBe(60);
    expect(r.gasSupply).toBe(20);
    expect(r.gasDelivery).toBe(30);
    expect(r.avgTemp).toBe(25);
    expect(r.billTotal).toBe(147.5);
  });

  it('per-fuel total = supply + delivery', () => {
    expect(r.elecBill).toBe(100); // 40 + 60
    expect(r.gasBill).toBe(50); // 20 + 30
  });

  it('rates: supply = cost/usage, all-in = (supply+delivery)/usage', () => {
    expect(r.elecRateSupply).toBeCloseTo(0.08, 10); // 40 / 500
    expect(r.gasRateSupply).toBeCloseTo(0.4, 10); // 20 / 50
    expect(r.elecRateAllIn).toBeCloseTo(0.2, 10); // 100 / 500
    expect(r.gasRateAllIn).toBeCloseTo(1.0, 10); // 50 / 50
  });

  it('degree-days attach to the month', () => {
    expect(r.hdd).toBe(1000);
    expect(r.cdd).toBe(250);
  });

  it('weather-normalized usage: kWh/(HDD+CDD) and therms/HDD', () => {
    // kwhPerDegreeDay = kwh / (hdd + cdd) = 500 / (1000 + 250) = 500 / 1250 = 0.4
    expect(r.kwhPerDegreeDay).toBeCloseTo(0.4, 10);
    // thermsPerHdd = therms / hdd = 50 / 1000 = 0.05
    expect(r.thermsPerHdd).toBeCloseTo(0.05, 10);
  });

  it('leaves normalized metrics null when degree-days are zero/missing', () => {
    const [noDD] = deriveMonthlySeries({
      usages: [{ periodYearMonth: 202603, usageType: 'TOTAL_KWH', quantity: 500 }],
      costs: [],
      weather: [],
      bills: [],
      degreeDays: [{ ym: 202603, hdd: 0, cdd: 0 }],
    });
    expect(noDD.kwhPerDegreeDay).toBeNull(); // 500 / 0 -> null
    expect(noDD.thermsPerHdd).toBeNull(); // no therms and hdd 0 -> null
  });

  it('leaves rates null when usage is missing (no divide-by-zero)', () => {
    const [only] = deriveMonthlySeries({
      usages: [],
      costs: [{ periodYearMonth: 202602, fuelType: 'ELECTRIC', kind: 'SUPPLY', amount: 40 }],
      weather: [],
      bills: [],
    });
    expect(only.elecRateSupply).toBeNull();
    expect(only.elecRateAllIn).toBeNull();
  });
});

const mkRow = (over: Partial<MonthRow>): MonthRow => ({
  ym: 0, label: '', kwh: null, therms: null,
  elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
  elecBill: null, gasBill: null,
  elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
  avgTemp: null, billTotal: null, days: null,
  hdd: null, cdd: null, kwhPerDegreeDay: null, thermsPerHdd: null, ...over,
});

describe('trailing12AllIn (hand-calculated)', () => {
  it('averages total cost / total usage over the most recent 12 months', () => {
    // 13 months; month i (1..13) has elecBill = i*10 on 100 kWh.
    // Last 12 = months 2..13: bills 20+30+...+130 = 900 over 1200 kWh -> 0.75.
    const rows = Array.from({ length: 13 }, (_, i) => mkRow({ ym: 202500 + i + 1, kwh: 100, elecBill: (i + 1) * 10 }));
    expect(trailing12AllIn(rows, 'elec')).toBeCloseTo(900 / 1200, 10); // 0.75
  });

  it('ignores months with zero or missing usage', () => {
    const rows = [mkRow({ kwh: 0, elecBill: 50 }), mkRow({ kwh: 100, elecBill: 20 })];
    expect(trailing12AllIn(rows, 'elec')).toBeCloseTo(0.2, 10); // only the 100-kWh month counts: 20/100
  });

  it('returns null when there is no usable data', () => {
    expect(trailing12AllIn([mkRow({ kwh: null, elecBill: 10 })], 'elec')).toBeNull();
  });
});
