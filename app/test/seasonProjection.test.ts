// Hand-calculated unit tests for the seasonal 12-month projection (issue #52).
// All PURE: no DB, no network, no React. projectSeason() fits usage vs degree-days
// internally (reusing the #44 regression), prices it with the trailing-12 all-in
// rate, and widens each month's band with the horizon. We construct tiny rows that
// produce a KNOWN fit and assert the projected usage/cost/band exactly.
import { describe, expect, it } from 'vitest';
import { projectSeason, seasonForwardRows, type ExpectedDegreeDays } from '../src/lib/prediction';
import type { MonthRow } from '../src/lib/chartSpec';

// Minimal MonthRow builder — only the fields the projector + trailing12AllIn read.
const mk = (p: Partial<MonthRow> & { ym: number }): MonthRow => ({
  ym: p.ym,
  label: '',
  kwh: p.kwh ?? null,
  therms: p.therms ?? null,
  elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
  elecBill: p.elecBill ?? null, gasBill: p.gasBill ?? null,
  elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
  avgTemp: null, billTotal: p.billTotal ?? null,
  hdd: p.hdd ?? null, cdd: p.cdd ?? null, kwhPerDegreeDay: null, thermsPerHdd: null,
});

// A normals lookup with the SAME HDD/CDD for every requested month, so each month
// projects identically and the only varying factor across the season is the
// horizon-widening of the band.
const flatNormals = (yms: number[], hdd: number, cdd: number): Map<number, ExpectedDegreeDays> =>
  new Map(yms.map((ym) => [ym, { hdd, cdd, forecastDays: 0, normalDays: 30 }]));

describe('projectSeason — fit-path projection + horizon-widening band (hand-calculated)', () => {
  // FOUR electric rows on the orthogonal (CDD,HDD) grid (0,0),(0,10),(10,0),(10,10)
  // with kwh = [101,119,130,150] (a true 100+3·CDD+2·HDD line nudged off by ±0.5):
  //   means CDD 5, HDD 5, ybar 125. Scc=100, Shh=100, Sch=0 (orthogonal), det=10000.
  //   Scy=300 -> slopeC = 300·100/10000 = 3
  //   Shy=190 -> slopeH = 190·100/10000 = 1.9 ; base = 125 - 3·5 - 1.9·5 = 100.5
  //   fitted 100.5/119.5/130.5/149.5 ; residuals 0.5/-0.5/-0.5/0.5 ; SS=1, dof=1
  //   -> residualStdev = sqrt(1) = 1.0
  // elecBill = 0.20·kwh per row -> sum cost 100 / sum kwh 500 -> all-in rate 0.20.
  // No gas usage -> gas fit insufficient and gas rate null (trailing12AllIn null).
  const rows: MonthRow[] = [
    mk({ ym: 202401, kwh: 101, cdd: 0, hdd: 0, elecBill: 20.2 }),
    mk({ ym: 202402, kwh: 119, cdd: 0, hdd: 10, elecBill: 23.8 }),
    mk({ ym: 202403, kwh: 130, cdd: 10, hdd: 0, elecBill: 26 }),
    mk({ ym: 202404, kwh: 150, cdd: 10, hdd: 10, elecBill: 30 }),
  ];
  // Latest usage row is 202404 -> projected months 202405 .. 202504 (h = 1..12).
  const projYms = Array.from({ length: 12 }, (_, i) => {
    // ymAddMonths(202404, i+1): 202405..202412 then 202501..202504
    const m = 4 + (i + 1);
    return m <= 12 ? 202400 + m : 202500 + (m - 12);
  });
  const normals = flatNormals(projYms, 30, 20); // every month: HDD 30, CDD 20

  const proj = projectSeason(rows, normals, { elec: 0.2, gas: null });

  it('projects 12 future months anchored after the latest usage row', () => {
    expect(proj.months).toHaveLength(12);
    expect(proj.months[0].ym).toBe(202405);
    expect(proj.months[11].ym).toBe(202504);
    expect(proj.months.every((m) => !m.fallback)).toBe(true); // all fit-path
  });

  it('projects usage from the recovered fit and prices at the all-in rate', () => {
    // elec usage = 100.5 + 3·20 + 1.9·30 = 100.5 + 60 + 57 = 217.5
    // cost = 217.5 · 0.20 = 43.5 ; gas dropped (no rate) -> projTherms null
    for (const m of proj.months) {
      expect(m.projKwh).toBeCloseTo(217.5, 6);
      expect(m.projTherms).toBeNull();
      expect(m.projCost).toBeCloseTo(43.5, 6);
    }
  });

  it('widens the band with the horizon: half(h) = k·σ·sqrt(h) in $', () => {
    // baseHalf (k=1) = 1·residualStdev = 1.0 (kWh) -> in $ = 1.0·0.20 = 0.20 at h=1.
    // half(h) = 0.20·sqrt(h). h=1 -> 0.20 ; h=4 -> 0.40 ; h=9 -> 0.60.
    const half = (m: { high: number; projCost: number }) => m.high - m.projCost;
    expect(half(proj.months[0])).toBeCloseTo(0.2, 6); // h=1
    expect(half(proj.months[3])).toBeCloseTo(0.4, 6); // h=4 -> sqrt 2
    expect(half(proj.months[8])).toBeCloseTo(0.6, 6); // h=9 -> sqrt 3
    // low = point - half
    expect(proj.months[0].low).toBeCloseTo(43.3, 6);
    expect(proj.months[3].low).toBeCloseTo(43.1, 6);
  });

  it('annual total = sum of 12 points; band = monthly halves in quadrature', () => {
    // point = 12 · 43.5 = 522.
    // annualHalf = sqrt(Σ half(h)²) = sqrt(Σ (0.20·sqrt(h))²) = 0.20·sqrt(Σ h)
    //   Σ h (1..12) = 78 ; sqrt(78) = 8.831761 ; annualHalf = 1.766352
    expect(proj.annual.point).toBeCloseTo(522, 6);
    expect(proj.annual.high - proj.annual.point).toBeCloseTo(1.766352, 5);
    expect(proj.annual.low).toBeCloseTo(520.233648, 5);
    expect(proj.basis).toContain('climatological projection');
  });
});

describe('projectSeason — same-month-last-year fallback (hand-calculated)', () => {
  // 13 monthly rows 202301..202401, each with usage but NO degree-days, so the fit
  // is insufficient (no fit observations). With an EMPTY normals map every month
  // must fall back to the same calendar month one year earlier.
  // elecBill = 0.10·kwh -> all-in rate 0.10 ; gasBill = 1·therms -> rate 1.00.
  const yms = [
    202301, 202302, 202303, 202304, 202305, 202306,
    202307, 202308, 202309, 202310, 202311, 202312, 202401,
  ];
  const built: MonthRow[] = yms.map((ym, i) =>
    mk({ ym, kwh: 100 + i, therms: 10 + i, elecBill: (100 + i) * 0.1, gasBill: (10 + i) * 1 })
  );

  const proj = projectSeason(built, new Map(), { elec: 0.1, gas: 1.0 });

  it('falls back to same-month-last-year usage, priced at current rates', () => {
    // Latest usage row 202401 -> first projected month 202402. Its same-month-last
    // -year is 202302 (kwh 101, therms 11). cost = 101·0.10 + 11·1.00 = 10.1 + 11 = 21.1
    const m = proj.months[0];
    expect(m.ym).toBe(202402);
    expect(m.fallback).toBe(true);
    expect(m.projKwh).toBeCloseTo(101, 6);
    expect(m.projTherms).toBeCloseTo(11, 6);
    expect(m.projCost).toBeCloseTo(21.1, 6);
  });

  it('marks the whole season climatological-fallback in the basis', () => {
    expect(proj.basis).toContain('climatological fallback');
  });

  it('drops a fuel/month with no same-month-last-year (projCost 0)', () => {
    // A SHORT history (only 202312 + 202401) with no degree-days and empty normals.
    // Latest usage 202401 -> months 202402..202501. The first projected month 202402
    // has same-month-last-year 202302 which is MISSING -> both fuels drop -> cost 0.
    const shortHist: MonthRow[] = [
      mk({ ym: 202312, kwh: 200, therms: 20, elecBill: 20, gasBill: 20 }),
      mk({ ym: 202401, kwh: 210, therms: 21, elecBill: 21, gasBill: 21 }),
    ];
    const p = projectSeason(shortHist, new Map(), { elec: 0.1, gas: 1.0 });
    const feb2024 = p.months.find((m) => m.ym === 202402)!;
    expect(feb2024.projKwh).toBeNull();
    expect(feb2024.projTherms).toBeNull();
    expect(feb2024.projCost).toBe(0);
    // 202412 -> 202312 EXISTS in this short history -> that month falls back, not dropped.
    const dec2024 = p.months.find((m) => m.ym === 202412)!;
    expect(dec2024.projKwh).toBeCloseTo(200, 6);
    expect(dec2024.fallback).toBe(true);
  });
});

describe('projectSeason — degenerate inputs', () => {
  it('returns an empty projection when there is no usage to anchor on', () => {
    const proj = projectSeason([], new Map(), { elec: 0.2, gas: 1.0 });
    expect(proj.months).toHaveLength(0);
    expect(proj.annual).toEqual({ point: 0, low: 0, high: 0 });
  });
});

describe('seasonForwardRows — declarative forward MonthRows', () => {
  it('maps each projected month to a future MonthRow carrying only proj* fields', () => {
    const proj = {
      months: [
        { ym: 202405, label: '2024-05', projKwh: 217.5, projTherms: null, projCost: 43.5, low: 43.3, high: 43.7, fallback: false },
      ],
      annual: { point: 43.5, low: 43.3, high: 43.7 },
      basis: 'x',
    };
    const fwd = seasonForwardRows(proj);
    expect(fwd).toHaveLength(1);
    expect(fwd[0].ym).toBe(202405);
    expect(fwd[0].projCost).toBe(43.5);
    expect(fwd[0].projKwh).toBe(217.5);
    // Historical chart fields are null so the solid series draws nothing here.
    expect(fwd[0].kwh).toBeNull();
    expect(fwd[0].billTotal).toBeNull();
    expect(fwd[0].elecSupply).toBeNull();
  });
});
