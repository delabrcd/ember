import { describe, expect, it } from 'vitest';
import {
  parseFuel,
  parseSinceDays,
  parseDate,
  parseGrain,
  parseIntervalQuery,
  FIFTEEN_MIN_SECONDS,
} from '../src/lib/intervalParams';

// Hand-calculated tests for the PURE interval query-param parser shared by
// /api/interval + /api/interval/heatmap + /api/interval/profile (issue #77). The
// three routes must parse fuel/from/to/sinceDays IDENTICALLY.

describe('parseFuel', () => {
  it('defaults to ELECTRIC and only honors an exact GAS', () => {
    expect(parseFuel(null)).toBe('ELECTRIC');
    expect(parseFuel('ELECTRIC')).toBe('ELECTRIC');
    expect(parseFuel('gas')).toBe('ELECTRIC'); // case-sensitive — not 'GAS'
    expect(parseFuel('GAS')).toBe('GAS');
  });
});

describe('parseSinceDays', () => {
  it('defaults to 30 for non-numeric input and clamps a number to [1, 400]', () => {
    // Note: Number(null) === 0 (finite) so a literal null clamps to 1, not the
    // default — matching the original /api/interval behavior. The default 30 is
    // for input that isn't a finite number at all.
    expect(parseSinceDays('not-a-number')).toBe(30);
    expect(parseSinceDays('0')).toBe(1); // clamp low
    expect(parseSinceDays('10')).toBe(10);
    expect(parseSinceDays('9999')).toBe(400); // clamp high
    expect(parseSinceDays('7.9')).toBe(7); // floored
  });
});

describe('parseGrain', () => {
  it('reads exact 15m / 1h grains; everything else is the all default', () => {
    expect(parseGrain('15m')).toBe('15m');
    expect(parseGrain('1h')).toBe('1h'); // reconcile-then-downsample hourly path
    expect(parseGrain(null)).toBe('all'); // absent
    expect(parseGrain('15M')).toBe('all'); // case-sensitive
    expect(parseGrain('1H')).toBe('all'); // case-sensitive
    expect(parseGrain('900')).toBe('all'); // not the seconds value, the grain token
    expect(parseGrain('3600')).toBe('all'); // ditto for hourly
    expect(parseGrain('garbage')).toBe('all');
  });

  it('FIFTEEN_MIN_SECONDS is 900 (the 15-minute grain in seconds)', () => {
    expect(FIFTEEN_MIN_SECONDS).toBe(900);
  });
});

describe('parseDate', () => {
  it('parses YYYY-MM-DD as a UTC start- or end-of-day instant', () => {
    expect(parseDate('2026-06-08', false)!.toISOString()).toBe('2026-06-08T00:00:00.000Z');
    expect(parseDate('2026-06-08', true)!.toISOString()).toBe('2026-06-08T23:59:59.999Z');
    expect(parseDate(null, false)).toBeNull();
    expect(parseDate('2026/06/08', false)).toBeNull(); // wrong format → null
  });
});

describe('parseIntervalQuery', () => {
  it('uses a concrete [from, to] window when present (end-of-day to)', () => {
    const { fuelType, window } = parseIntervalQuery(
      new URLSearchParams('fuel=GAS&from=2026-06-01&to=2026-06-07&sinceDays=5')
    );
    expect(fuelType).toBe('GAS');
    expect('from' in window).toBe(true);
    const w = window as { from?: Date; to?: Date };
    expect(w.from!.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(w.to!.toISOString()).toBe('2026-06-07T23:59:59.999Z'); // to wins over sinceDays
  });

  it('swaps inverted from/to bounds (the Date objects are swapped as-is)', () => {
    // from=06-07 (start-of-day) > to=06-01 (end-of-day) → swapped. The swap moves
    // the Date OBJECTS, so the (parsed end-of-day) 06-01 becomes the lower bound
    // and the (start-of-day) 06-07 becomes the upper — matching /api/interval.
    const { window } = parseIntervalQuery(new URLSearchParams('from=2026-06-07&to=2026-06-01'));
    const w = window as { from?: Date; to?: Date };
    expect(w.from!.toISOString()).toBe('2026-06-01T23:59:59.999Z');
    expect(w.to!.toISOString()).toBe('2026-06-07T00:00:00.000Z');
  });

  it('falls back to a trailing sinceDays window when no from/to', () => {
    const { window } = parseIntervalQuery(new URLSearchParams('sinceDays=14'));
    expect('sinceDays' in window).toBe(true);
    expect((window as { sinceDays: number }).sinceDays).toBe(14);
  });

  it('defaults grain to "all" and reads exact grain=15m / grain=1h', () => {
    // Absent → 'all' (downsampled, all grains — back-compat / non-dashboard callers).
    expect(parseIntervalQuery(new URLSearchParams('fuel=ELECTRIC')).grain).toBe('all');
    // grain=1h flips to the reconcile-then-downsample hourly path.
    expect(parseIntervalQuery(new URLSearchParams('fuel=ELECTRIC&grain=1h')).grain).toBe('1h');
    // grain=15m flips to the raw path while the rest of the query is parsed as usual.
    const q = parseIntervalQuery(new URLSearchParams('fuel=ELECTRIC&from=2026-06-01&to=2026-06-07&grain=15m'));
    expect(q.grain).toBe('15m');
    expect(q.fuelType).toBe('ELECTRIC');
    const w = q.window as { from?: Date; to?: Date };
    expect(w.from!.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(w.to!.toISOString()).toBe('2026-06-07T23:59:59.999Z');
  });
});
