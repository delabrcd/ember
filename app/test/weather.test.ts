import { describe, expect, it } from 'vitest';
import { geocodeQuery, pickGeoResult } from '../src/lib/weather/geocode';
import {
  dailyToMonthlyMean,
  parseArchiveDaily,
  rollupDailyToMonthly,
  type DailyTemp,
} from '../src/lib/weather/openMeteo';
import { monthlyTempByYm } from '../src/lib/weather/monthlyTemp';

describe('geocodeQuery (hand-calculated)', () => {
  it('prefers a US ZIP when present', () => {
    expect(geocodeQuery('123 Main St, Albany, NY 12203')).toBe('12203');
    expect(geocodeQuery('Albany, NY 12203-1234')).toBe('12203'); // ZIP+4 → 5-digit
  });

  it('falls back to the first non-street token when there is no ZIP', () => {
    // Leading "123 Main St" starts with a digit → skipped; "Albany" wins.
    expect(geocodeQuery('123 Main St, Albany, NY')).toBe('Albany');
  });

  it('returns null for empty/missing input', () => {
    expect(geocodeQuery('')).toBeNull();
    expect(geocodeQuery(null)).toBeNull();
    expect(geocodeQuery(undefined)).toBeNull();
  });
});

describe('pickGeoResult (hand-calculated)', () => {
  it('takes the first usable hit', () => {
    expect(
      pickGeoResult({ results: [{ latitude: 42.6526, longitude: -73.7562, name: 'Albany' }] })
    ).toEqual({ latitude: 42.6526, longitude: -73.7562 });
  });

  it('skips hits missing coords and returns null when none are usable', () => {
    expect(pickGeoResult({ results: [{ name: 'Nowhere' }] })).toBeNull();
    expect(pickGeoResult({ results: [] })).toBeNull();
    expect(pickGeoResult(null)).toBeNull();
  });
});

describe('parseArchiveDaily (hand-calculated)', () => {
  it('zips the parallel arrays and drops days with no mean', () => {
    const rows = parseArchiveDaily({
      daily: {
        time: ['2026-01-01', '2026-01-02', '2026-01-03'],
        temperature_2m_mean: [30, null, 34],
        temperature_2m_min: [20, 22, 24],
        temperature_2m_max: [40, 42, 44],
      },
    });
    // Day 2 has a null mean → dropped.
    expect(rows).toEqual([
      { date: '2026-01-01', tMean: 30, tMin: 20, tMax: 40 },
      { date: '2026-01-03', tMean: 34, tMin: 24, tMax: 44 },
    ]);
  });

  it('returns [] when there is no daily block', () => {
    expect(parseArchiveDaily(null)).toEqual([]);
    expect(parseArchiveDaily({})).toEqual([]);
  });
});

describe('rollupDailyToMonthly (hand-calculated)', () => {
  const daily: DailyTemp[] = [
    // Jan: means 30, 32, 34 → avg 32; mins 20,21,22 → 20; maxs 40,41,48 → 48
    { date: '2026-01-01', tMean: 30, tMin: 20, tMax: 40 },
    { date: '2026-01-15', tMean: 32, tMin: 21, tMax: 41 },
    { date: '2026-01-31', tMean: 34, tMin: 22, tMax: 48 },
    // Feb: means 50, 60 → avg 55; mins 45,55 → 45; maxs 65,75 → 75
    { date: '2026-02-10', tMean: 50, tMin: 45, tMax: 65 },
    { date: '2026-02-20', tMean: 60, tMin: 55, tMax: 75 },
  ];
  const rows = rollupDailyToMonthly(daily);

  it('produces one sorted row per month', () => {
    expect(rows.map((r) => r.ym)).toEqual([202601, 202602]);
    expect(rows.map((r) => r.monthYear)).toEqual(['2026-01-01', '2026-02-01']);
  });

  it('avgTemperature is the mean of the daily means', () => {
    expect(rows[0].avgTemperature).toBeCloseTo(32, 10); // (30+32+34)/3
    expect(rows[1].avgTemperature).toBeCloseTo(55, 10); // (50+60)/2
  });

  it('tMin/tMax are the monthly extremes; days counts the samples', () => {
    expect(rows[0].tMin).toBe(20);
    expect(rows[0].tMax).toBe(48);
    expect(rows[0].days).toBe(3);
    expect(rows[1].tMin).toBe(45);
    expect(rows[1].tMax).toBe(75);
    expect(rows[1].days).toBe(2);
  });

  it('handles missing min/max gracefully', () => {
    const r = rollupDailyToMonthly([
      { date: '2026-03-01', tMean: 10, tMin: null, tMax: null },
      { date: '2026-03-02', tMean: 20, tMin: null, tMax: null },
    ]);
    expect(r[0].avgTemperature).toBe(15);
    expect(r[0].tMin).toBeNull();
    expect(r[0].tMax).toBeNull();
  });

  it('returns [] for no input', () => {
    expect(rollupDailyToMonthly([])).toEqual([]);
  });
});

describe('monthlyTempByYm precedence (hand-calculated)', () => {
  // Daily means: Jan 30/34 -> avg 32 ; Feb 50/60 -> avg 55.
  const daily: DailyTemp[] = [
    { date: '2026-01-01', tMean: 30, tMin: null, tMax: null },
    { date: '2026-01-31', tMean: 34, tMin: null, tMax: null },
    { date: '2026-02-10', tMean: 50, tMin: null, tMax: null },
    { date: '2026-02-20', tMean: 60, tMin: null, tMax: null },
  ];

  it('prefers open-meteo monthly over NG and over the daily rollup', () => {
    const m = monthlyTempByYm(
      [
        { ym: 202601, avgTemperature: 99, source: 'open-meteo' }, // wins for Jan
        { ym: 202601, avgTemperature: 11, source: 'ng' },
      ],
      daily
    );
    expect(m.get(202601)).toBe(99); // open-meteo monthly, not the 32 rollup or NG 11
  });

  it('falls back to the account daily rollup when no monthly row exists (region null/mismatch)', () => {
    // No monthly rows at all (the region read returned []), only account daily.
    const m = monthlyTempByYm([], daily);
    expect(m.get(202601)).toBeCloseTo(32, 10); // (30+34)/2
    expect(m.get(202602)).toBeCloseTo(55, 10); // (50+60)/2
  });

  it('uses NG monthly only for months the rollup does not cover', () => {
    // Daily covers Jan+Feb; NG also has a March the daily set lacks.
    const m = monthlyTempByYm(
      [{ ym: 202603, avgTemperature: 40, source: 'ng' }],
      daily
    );
    expect(m.get(202601)).toBeCloseTo(32, 10); // daily rollup
    expect(m.get(202603)).toBe(40); // NG fallback fills the gap
  });

  it('open-meteo monthly is not overwritten by a later daily rollup for the same month', () => {
    const m = monthlyTempByYm([{ ym: 202601, avgTemperature: 77, source: 'open-meteo' }], daily);
    expect(m.get(202601)).toBe(77);
  });
});

describe('dailyToMonthlyMean (hand-calculated)', () => {
  it('averages the daily means', () => {
    expect(
      dailyToMonthlyMean([
        { date: '2026-01-01', tMean: 10, tMin: null, tMax: null },
        { date: '2026-01-02', tMean: 20, tMin: null, tMax: null },
        { date: '2026-01-03', tMean: 30, tMin: null, tMax: null },
      ])
    ).toBeCloseTo(20, 10);
  });

  it('returns null with no samples', () => {
    expect(dailyToMonthlyMean([])).toBeNull();
  });
});
