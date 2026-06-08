import { describe, expect, it } from 'vitest';
import type { MonthRow } from '../src/lib/chartSpec';
import { compareYoY, latestVsYearAgo } from '../src/lib/series';
import { signedPct, yoyVerdict } from '../src/lib/format';

const mkRow = (over: Partial<MonthRow>): MonthRow => ({
  ym: 0, label: '', kwh: null, therms: null,
  elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
  elecBill: null, gasBill: null,
  elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
  avgTemp: null, billTotal: null, days: null,
  hdd: null, cdd: null, kwhPerDegreeDay: null, thermsPerHdd: null, ...over,
});

describe('compareYoY (hand-calculated)', () => {
  // Period B (prior year): 10000 kWh over 10000 degree-days (HDD 8000 + CDD 2000)
  //   → intensity Ib = 1.0 kWh/DD.
  // Period A (recent):     10600 kWh over 11400 degree-days (HDD 9000 + CDD 2400)
  //   → intensity Ia = 10600 / 11400 = 0.929824...
  // Raw usage: +600 kWh = +6%. Degree-days: +1400 = +14%.
  // Normalized (intensity): (0.929824 − 1) / 1 = −0.070175 ≈ −7%.
  // Decomposition:
  //   weather-explained = Ib·(Da − Db) = 1.0 × (11400 − 10000) = +1400 kWh
  //   intensity         = (Ia − Ib)·Da = (−0.070175) × 11400    = −800 kWh
  //   sum = +1400 − 800 = +600 kWh = the raw delta (exact).
  const periodB = [mkRow({ kwh: 10000, hdd: 8000, cdd: 2000 })];
  const periodA = [mkRow({ kwh: 10600, hdd: 9000, cdd: 2400 })];

  it('separates the raw delta into weather + intensity (they sum exactly)', () => {
    const { elec } = compareYoY(periodA, periodB);
    expect(elec).not.toBeNull();
    const e = elec!;
    expect(e.usageA).toBe(10600);
    expect(e.usageB).toBe(10000);
    expect(e.ddA).toBe(11400); // 9000 + 2400
    expect(e.ddB).toBe(10000); // 8000 + 2000
    expect(e.intensityA).toBeCloseTo(10600 / 11400, 10);
    expect(e.intensityB).toBeCloseTo(1.0, 10);

    expect(e.rawUsageDelta).toBe(600);
    expect(e.rawUsagePct).toBeCloseTo(0.06, 10); // +6%
    expect(e.ddPct).toBeCloseTo(0.14, 10); // +14%
    expect(e.normalizedPct).toBeCloseTo(-0.0701754, 6); // ≈ −7%

    expect(e.weatherExplainedDelta).toBeCloseTo(1400, 6);
    expect(e.intensityDelta).toBeCloseTo(-800, 6);
    // The decomposition is exact: weather + intensity = raw.
    expect(e.weatherExplainedDelta + e.intensityDelta).toBeCloseTo(e.rawUsageDelta, 6);
  });

  it('headline reads "more usage but colder → lower after normalizing"', () => {
    const { elec } = compareYoY(periodA, periodB);
    // "Electric: +6% kWh, but +14% degree-days — ~7% lower after normalizing."
    expect(yoyVerdict(elec!, 'Electric', 'kWh')).toBe(
      'Electric: +6% kWh, but +14% degree-days — ~7% lower after normalizing.'
    );
  });

  it('CONSTRUCTED: same intensity, colder year → ~0 normalized change', () => {
    // Gas, heating-only (degree-days = HDD). Prior year 1000 therms over 2000 HDD
    // → 0.5 therms/HDD. This year colder: 2400 HDD, and the SAME 0.5 intensity →
    // 1200 therms. Raw usage is +200 therms (+20%), but it's ENTIRELY explained
    // by the colder weather: normalized change is exactly 0.
    const b = [mkRow({ therms: 1000, hdd: 2000 })];
    const a = [mkRow({ therms: 1200, hdd: 2400 })];
    const { gas } = compareYoY(a, b);
    expect(gas).not.toBeNull();
    const g = gas!;
    expect(g.intensityA).toBeCloseTo(0.5, 10);
    expect(g.intensityB).toBeCloseTo(0.5, 10);
    expect(g.rawUsageDelta).toBe(200);
    expect(g.rawUsagePct).toBeCloseTo(0.2, 10); // +20% raw
    expect(g.ddPct).toBeCloseTo(0.2, 10); // +20% colder
    expect(g.normalizedPct).toBeCloseTo(0, 10); // genuine change ≈ 0
    expect(g.weatherExplainedDelta).toBeCloseTo(200, 6); // all of it is weather
    expect(g.intensityDelta).toBeCloseTo(0, 6);
    expect(yoyVerdict(g, 'Gas', 'therms')).toBe(
      'Gas: +20% therms, but +20% degree-days — about flat after normalizing.'
    );
  });

  it('gas degree-days are HDD only (cooling ignored)', () => {
    // CDD present but irrelevant for gas. Prior: 500 therms / 1000 HDD = 0.5.
    // This year: 480 therms / 1000 HDD = 0.48 → genuinely −4% with flat weather.
    const b = [mkRow({ therms: 500, hdd: 1000, cdd: 9999 })];
    const a = [mkRow({ therms: 480, hdd: 1000, cdd: 1 })];
    const { gas } = compareYoY(a, b);
    expect(gas!.ddA).toBe(1000);
    expect(gas!.ddB).toBe(1000);
    expect(gas!.ddPct).toBeCloseTo(0, 10);
    expect(gas!.normalizedPct).toBeCloseTo(-0.04, 10); // (0.48 − 0.5)/0.5
  });

  it('normalized cost prices both periods at the current rate + this years DD', () => {
    // Electric, rate 0.20 $/kWh. ddA = 11400.
    //   normCostA = Ia × ddA × rate = (10600/11400) × 11400 × 0.20 = 10600 × 0.20 = 2120
    //   normCostB = Ib × ddA × rate = 1.0      × 11400 × 0.20 = 2280
    //   delta = 2120 − 2280 = −160 (cheaper after normalizing for weather + rate).
    const { elec } = compareYoY(periodA, periodB, { elec: 0.2 });
    const e = elec!;
    expect(e.rate).toBe(0.2);
    expect(e.normCostA).toBeCloseTo(2120, 6);
    expect(e.normCostB).toBeCloseTo(2280, 6);
    expect(e.normCostDelta).toBeCloseTo(-160, 6);
  });

  it('omits cost when no/invalid rate is supplied', () => {
    const { elec } = compareYoY(periodA, periodB); // no rates
    expect(elec!.rate).toBeNull();
    expect(elec!.normCostA).toBeNull();
    expect(elec!.normCostB).toBeNull();
    expect(elec!.normCostDelta).toBeNull();
    // A non-positive rate is ignored too.
    const zero = compareYoY(periodA, periodB, { elec: 0 }).elec!;
    expect(zero.rate).toBeNull();
    expect(zero.normCostDelta).toBeNull();
  });

  it('aggregates multi-month windows usage-weighted, skipping unusable rows', () => {
    // Period A: two usable months + one with no degree-days (dropped).
    //   600 kWh / 1000 DD and 400 kWh / 1000 DD → 1000 kWh over 2000 DD = 0.5.
    const a = [
      mkRow({ kwh: 600, hdd: 800, cdd: 200 }),
      mkRow({ kwh: 400, hdd: 700, cdd: 300 }),
      mkRow({ kwh: 999, hdd: 0, cdd: 0 }), // dropped: no degree-days
    ];
    // Period B: 1000 kWh over 1000 DD → intensity 1.0.
    const b = [mkRow({ kwh: 1000, hdd: 800, cdd: 200 })];
    const { elec } = compareYoY(a, b);
    expect(elec!.usageA).toBe(1000); // 600 + 400 (999-row excluded)
    expect(elec!.ddA).toBe(2000);
    expect(elec!.intensityA).toBeCloseTo(0.5, 10);
    expect(elec!.normalizedPct).toBeCloseTo(-0.5, 10); // (0.5 − 1.0)/1.0
  });

  it('returns null for a fuel with no usable data in either window', () => {
    const a = [mkRow({ kwh: 500, hdd: 1000, cdd: 0 })]; // electric only
    const b = [mkRow({ kwh: 500, hdd: 1000, cdd: 0 })];
    const { elec, gas } = compareYoY(a, b);
    expect(elec).not.toBeNull();
    expect(gas).toBeNull(); // no therms anywhere
  });
});

describe('latestVsYearAgo (single-month window picker, hand-calculated)', () => {
  it('compares the latest usage month against the same month a year earlier', () => {
    // Latest usage row is Mar 2025 (202503); its prior-year match is 202403.
    // Electric: prior 800 kWh / 1000 DD = 0.8; latest 900 kWh / 1000 DD = 0.9.
    //   raw +100 kWh (+12.5%), DD flat, normalized (0.9 − 0.8)/0.8 = +12.5%.
    const rows: MonthRow[] = [
      mkRow({ ym: 202403, kwh: 800, hdd: 1000, cdd: 0 }),
      mkRow({ ym: 202412, kwh: 850, hdd: 1000, cdd: 0 }), // noise between the two
      mkRow({ ym: 202503, kwh: 900, hdd: 1000, cdd: 0 }),
    ];
    const res = latestVsYearAgo(rows);
    expect(res).not.toBeNull();
    expect(res!.elec).not.toBeNull();
    const e = res!.elec!;
    expect(e.usageA).toBe(900);
    expect(e.usageB).toBe(800);
    expect(e.rawUsagePct).toBeCloseTo(0.125, 10);
    expect(e.ddPct).toBeCloseTo(0, 10);
    expect(e.normalizedPct).toBeCloseTo(0.125, 10);
  });

  it('returns a per-fuel null (→ "—") when only one fuel has a prior-year match', () => {
    // Latest month has both fuels; prior-year month has gas only → elec is null,
    // gas compares. (compareYoY yields null per fuel with no usable B data.)
    const rows: MonthRow[] = [
      mkRow({ ym: 202403, therms: 100, hdd: 500 }), // prior year: gas only
      mkRow({ ym: 202503, kwh: 900, therms: 110, hdd: 500, cdd: 0 }),
    ];
    const res = latestVsYearAgo(rows)!;
    expect(res.elec).toBeNull(); // no electric in the prior-year window
    expect(res.gas).not.toBeNull();
    expect(res.gas!.usageA).toBe(110);
    expect(res.gas!.usageB).toBe(100);
  });

  it('returns null when there is no prior-year row to match', () => {
    const rows: MonthRow[] = [mkRow({ ym: 202503, kwh: 900, hdd: 1000, cdd: 0 })];
    expect(latestVsYearAgo(rows)).toBeNull();
  });

  it('returns null with no usage anywhere', () => {
    const rows: MonthRow[] = [mkRow({ ym: 202503, hdd: 1000 })];
    expect(latestVsYearAgo(rows)).toBeNull();
  });
});

describe('signedPct + yoyVerdict (presentation, hand-checked)', () => {
  it('signedPct formats fractions with a sign and a true minus', () => {
    expect(signedPct(0.062)).toBe('+6%');
    expect(signedPct(-0.071)).toBe('−7%');
    expect(signedPct(0)).toBe('0%');
    expect(signedPct(null)).toBe('—');
  });

  it('verdict falls back gracefully when normalized % is unavailable', () => {
    // Prior-year intensity 0 (no degree-days last year) → null normalizedPct.
    const a = [mkRow({ kwh: 500, hdd: 1000, cdd: 0 })];
    const b = [mkRow({ kwh: 500, hdd: 1000, cdd: 0 })];
    const e = compareYoY(a, b).elec!;
    // Both have data here, so just sanity-check the higher-usage wording path
    // via a hand-made result is covered above; verify the unavailable branch by
    // forcing normalizedPct null.
    const forced = { ...e, rawUsagePct: null, ddPct: null, normalizedPct: null };
    expect(yoyVerdict(forced, 'Electric', 'kWh')).toBe(
      'Electric: — kWh, but — degree-days — normalized change unavailable.'
    );
  });
});
