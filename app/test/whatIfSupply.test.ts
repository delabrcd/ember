import { describe, expect, it } from 'vitest';
import type { MonthRow } from '../src/lib/chartSpec';
import { whatIfSupply, withSupplyRateTrailing } from '../src/lib/series';

const mkRow = (over: Partial<MonthRow>): MonthRow => ({
  ym: 0, label: '', kwh: null, therms: null,
  elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
  elecBill: null, gasBill: null,
  elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
  avgTemp: null, billTotal: null, days: null,
  hdd: null, cdd: null, kwhPerDegreeDay: null, thermsPerHdd: null, ...over,
});

describe('whatIfSupply (hand-calculated)', () => {
  // Three months of electricity. Actual PDF supply cost and usage:
  //   M1: $130 over 1000 kWh   (actual rate 0.130/kWh)
  //   M2: $150 over 1000 kWh   (actual rate 0.150/kWh)
  //   M3: $140 over 1000 kWh   (actual rate 0.140/kWh)
  // Totals: actual supply = 130 + 150 + 140 = $420 over 3000 kWh.
  // Hypothetical fixed 0.12/kWh: 3000 × 0.12 = $360.
  // Delta = 360 − 420 = −$60  → you'd have SAVED $60.
  const elecRows = [
    mkRow({ kwh: 1000, elecSupply: 130 }),
    mkRow({ kwh: 1000, elecSupply: 150 }),
    mkRow({ kwh: 1000, elecSupply: 140 }),
  ];

  it('back-tests a hypothetical fixed elec supply rate against actual usage', () => {
    const { elec } = whatIfSupply(elecRows, { elecRate: 0.12 });
    expect(elec).not.toBeNull();
    const e = elec!;
    expect(e.fuel).toBe('elec');
    expect(e.rate).toBe(0.12);
    expect(e.usage).toBe(3000);
    expect(e.months).toBe(3);
    expect(e.actual).toBeCloseTo(420, 10);
    expect(e.hypothetical).toBeCloseTo(360, 10); // 3000 × 0.12
    expect(e.delta).toBeCloseTo(-60, 10); // saved $60
  });

  it('a HIGHER hypothetical rate costs more (positive delta)', () => {
    // 3000 kWh × 0.16 = $480 vs $420 paid → +$60 (worse).
    const { elec } = whatIfSupply(elecRows, { elecRate: 0.16 });
    expect(elec!.hypothetical).toBeCloseTo(480, 10);
    expect(elec!.delta).toBeCloseTo(60, 10);
  });

  it('prices each fuel independently and combines the net delta', () => {
    // Gas: M1 $90 / 100 therms, M2 $110 / 100 therms → actual $200 over 200 therms.
    //   Hypothetical 1.20/therm: 200 × 1.20 = $240. Gas delta = +$40.
    // Elec (from above): hypothetical $360 vs $420 → −$60.
    // Net = (360 + 240) − (420 + 200) = 600 − 620 = −$20 saved overall.
    const rows = [
      mkRow({ kwh: 1000, elecSupply: 130, therms: 100, gasSupply: 90 }),
      mkRow({ kwh: 1000, elecSupply: 150, therms: 100, gasSupply: 110 }),
      mkRow({ kwh: 1000, elecSupply: 140 }),
    ];
    const r = whatIfSupply(rows, { elecRate: 0.12, gasRate: 1.2 });
    expect(r.elec!.actual).toBeCloseTo(420, 10);
    expect(r.elec!.hypothetical).toBeCloseTo(360, 10);
    expect(r.gas!.usage).toBe(200);
    expect(r.gas!.months).toBe(2);
    expect(r.gas!.actual).toBeCloseTo(200, 10);
    expect(r.gas!.hypothetical).toBeCloseTo(240, 10); // 200 × 1.20
    expect(r.gas!.delta).toBeCloseTo(40, 10);
    // Combined.
    expect(r.actual).toBeCloseTo(620, 10);
    expect(r.hypothetical).toBeCloseTo(600, 10);
    expect(r.delta).toBeCloseTo(-20, 10);
  });

  it('skips a fuel with no rate, only counting the priced one', () => {
    const r = whatIfSupply(elecRows, { elecRate: 0.12 }); // no gas rate
    expect(r.gas).toBeNull();
    // Combined reflects only the elec fuel.
    expect(r.actual).toBeCloseTo(420, 10);
    expect(r.hypothetical).toBeCloseTo(360, 10);
    expect(r.delta).toBeCloseTo(-60, 10);
  });

  it('ignores a non-positive or missing rate and returns null totals when nothing priced', () => {
    expect(whatIfSupply(elecRows, { elecRate: 0 }).elec).toBeNull();
    expect(whatIfSupply(elecRows, { elecRate: -1 }).elec).toBeNull();
    const none = whatIfSupply(elecRows, {});
    expect(none.elec).toBeNull();
    expect(none.gas).toBeNull();
    expect(none.actual).toBeNull();
    expect(none.hypothetical).toBeNull();
    expect(none.delta).toBeNull();
  });

  it('only counts months that have BOTH supply cost and usage', () => {
    // Month with usage but no supply cost, and one with cost but no usage, are both
    // dropped so actual and hypothetical span the same months.
    const rows = [
      mkRow({ kwh: 1000, elecSupply: 130 }), // counted
      mkRow({ kwh: 500, elecSupply: null }), // no cost → dropped
      mkRow({ kwh: null, elecSupply: 99 }), // no usage → dropped
      mkRow({ kwh: 0, elecSupply: 50 }), // zero usage → dropped
    ];
    const e = whatIfSupply(rows, { elecRate: 0.1 }).elec!;
    expect(e.months).toBe(1);
    expect(e.usage).toBe(1000);
    expect(e.actual).toBeCloseTo(130, 10);
    expect(e.hypothetical).toBeCloseTo(100, 10); // 1000 × 0.10
    expect(e.delta).toBeCloseTo(-30, 10);
  });

  it('returns null for a fuel with no usable months', () => {
    const rows = [mkRow({ kwh: 1000, elecSupply: 130 })]; // electric only
    const r = whatIfSupply(rows, { elecRate: 0.12, gasRate: 1.2 });
    expect(r.elec).not.toBeNull();
    expect(r.gas).toBeNull(); // no therms/gas supply anywhere
  });
});

describe('withSupplyRateTrailing (hand-calculated)', () => {
  it('stamps a usage-weighted trailing-average supply rate per fuel', () => {
    // Electric, window 3. Per-month supply cost / kWh:
    //   M1: $100 / 1000   M2: $240 / 2000   M3: $180 / 1000   M4: $200 / 1000
    // Row averages (usage-weighted = Σcost / Σusage over the trailing window):
    //   M1: 100/1000 = 0.10
    //   M2: (100+240)/(1000+2000) = 340/3000 = 0.113333…
    //   M3: (100+240+180)/(1000+2000+1000) = 520/4000 = 0.130
    //   M4: (240+180+200)/(2000+1000+1000) = 620/4000 = 0.155   (M1 falls out)
    const rows = [
      mkRow({ kwh: 1000, elecSupply: 100 }),
      mkRow({ kwh: 2000, elecSupply: 240 }),
      mkRow({ kwh: 1000, elecSupply: 180 }),
      mkRow({ kwh: 1000, elecSupply: 200 }),
    ];
    const out = withSupplyRateTrailing(rows, 3);
    expect(out[0].elecRateSupplyAvg).toBeCloseTo(0.1, 10);
    expect(out[1].elecRateSupplyAvg).toBeCloseTo(340 / 3000, 10);
    expect(out[2].elecRateSupplyAvg).toBeCloseTo(0.13, 10);
    expect(out[3].elecRateSupplyAvg).toBeCloseTo(620 / 4000, 10);
  });

  it('skips months missing cost or usage and nulls a row with an empty window', () => {
    const rows = [
      mkRow({ kwh: null, elecSupply: null }), // nothing usable in its window
      mkRow({ kwh: 1000, elecSupply: 150 }), // window = [M1(empty), M2] → 150/1000
    ];
    const out = withSupplyRateTrailing(rows, 3);
    expect(out[0].elecRateSupplyAvg).toBeNull();
    expect(out[1].elecRateSupplyAvg).toBeCloseTo(0.15, 10);
  });

  it('computes gas independently from electric', () => {
    const rows = [
      mkRow({ therms: 100, gasSupply: 120 }),
      mkRow({ therms: 100, gasSupply: 140 }),
    ];
    const out = withSupplyRateTrailing(rows, 6);
    expect(out[0].gasRateSupplyAvg).toBeCloseTo(1.2, 10);
    expect(out[1].gasRateSupplyAvg).toBeCloseTo((120 + 140) / 200, 10); // 1.30
    // No electric data → null electric average.
    expect(out[0].elecRateSupplyAvg).toBeNull();
  });
});
