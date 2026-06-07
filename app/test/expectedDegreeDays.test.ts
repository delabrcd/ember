// Hand-calculated unit tests for the PURE pieces of the expected-degree-day
// assembly (issue #44). The fetch/DB wrapper (expectedDegreeDaysForWindow) is
// intentionally NOT exercised here — these tests never touch the network. They
// prove the assembly math and that the forecast/normals split is data-only, so
// the impure wrapper can hand it a (possibly empty) forecast and normals and
// always get a finite result.
import { describe, expect, it } from 'vitest';
import {
  assembleExpectedDegreeDays,
  dayOfYearNormals,
  daysInRange,
  overallMean,
} from '../src/lib/weather/expectedDegreeDays';
import type { DailyTemp } from '../src/lib/weather/openMeteo';

const D = (s: string) => new Date(s + 'T00:00:00Z');
const ft = (date: string, tMean: number): DailyTemp => ({ date, tMean, tMin: null, tMax: null });

describe('daysInRange (hand-calculated)', () => {
  it('lists inclusive UTC days', () => {
    expect(daysInRange(D('2026-06-10'), D('2026-06-13'))).toEqual([
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
    ]);
  });
  it('is empty for an inverted range', () => {
    expect(daysInRange(D('2026-06-13'), D('2026-06-10'))).toEqual([]);
  });
});

describe('dayOfYearNormals / overallMean (hand-calculated)', () => {
  const history = [
    { date: '2024-01-15', tMean: 30 },
    { date: '2025-01-15', tMean: 34 }, // same MM-DD -> mean 32
    { date: '2024-07-15', tMean: 80 },
  ];
  it('averages each MM-DD across years', () => {
    const n = dayOfYearNormals(history);
    expect(n.get('01-15')).toBeCloseTo(32, 9); // (30+34)/2
    expect(n.get('07-15')).toBeCloseTo(80, 9);
    expect(n.size).toBe(2);
  });
  it('overallMean is the mean of all daily means', () => {
    expect(overallMean(history)).toBeCloseTo((30 + 34 + 80) / 3, 9); // 48
  });
  it('overallMean is null with no history', () => {
    expect(overallMean([])).toBeNull();
  });
});

describe('assembleExpectedDegreeDays (hand-calculated)', () => {
  const base = 65;

  it('uses the forecast where present and normals elsewhere, then sums DD', () => {
    // Window 4 days. Forecast covers the first 2 days; normals cover the rest.
    //   2026-01-10 forecast 60 -> HDD 5
    //   2026-01-11 forecast 70 -> CDD 5
    //   2026-01-12 normal (MM-DD 01-12) 45 -> HDD 20
    //   2026-01-13 no same-day normal -> overall mean 80 -> CDD 15
    //   HDD = 5 + 20 = 25 ; CDD = 5 + 15 = 20
    //   forecastDays 2 ; normalDays 2
    const windowDays = daysInRange(D('2026-01-10'), D('2026-01-13'));
    const forecast = [ft('2026-01-10', 60), ft('2026-01-11', 70)];
    const normals = new Map<string, number>([['01-12', 45]]);
    const r = assembleExpectedDegreeDays(windowDays, forecast, normals, 80, base);
    expect(r.hdd).toBeCloseTo(25, 9);
    expect(r.cdd).toBeCloseTo(20, 9);
    expect(r.forecastDays).toBe(2);
    expect(r.normalDays).toBe(2);
  });

  it('falls back to normals for the whole window when the forecast is empty', () => {
    // Empty forecast (the wrapper passes [] on any fetch failure). All 3 days
    // come from normals: 50 -> HDD 15, 50 -> HDD 15, 90 -> CDD 25.
    //   HDD = 30 ; CDD = 25 ; forecastDays 0 ; normalDays 3
    const windowDays = daysInRange(D('2026-02-01'), D('2026-02-03'));
    const normals = new Map<string, number>([
      ['02-01', 50],
      ['02-02', 50],
      ['02-03', 90],
    ]);
    const r = assembleExpectedDegreeDays(windowDays, [], normals, 63, base);
    expect(r.hdd).toBeCloseTo(30, 9);
    expect(r.cdd).toBeCloseTo(25, 9);
    expect(r.forecastDays).toBe(0);
    expect(r.normalDays).toBe(3);
  });

  it('drops a day with neither forecast nor any history', () => {
    // One window day, no forecast, no normals, no overall -> contributes nothing.
    const r = assembleExpectedDegreeDays(['2026-03-01'], [], new Map(), null, base);
    expect(r).toEqual({ hdd: 0, cdd: 0, forecastDays: 0, normalDays: 0 });
  });
});
