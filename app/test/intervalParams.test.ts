import { describe, expect, it } from 'vitest';
import {
  parseFuel,
  parseSinceDays,
  parseDate,
  parseGrain,
  parseBucket,
  parseIntervalQuery,
  resolveWindowBounds,
  FIFTEEN_MIN_SECONDS,
} from '../src/lib/intervalParams';
import { BUCKET_LADDER_SECONDS } from '../src/lib/viz/chooseBucket';

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

// WS8: parseBucket accepts ONLY a chooseBucket-ladder width (seconds); anything else
// (absent, off-ladder, garbage) → null = "server picks the bucket".
describe('parseBucket', () => {
  it('accepts each ladder width verbatim', () => {
    for (const w of BUCKET_LADDER_SECONDS) {
      expect(parseBucket(String(w))).toBe(w);
    }
    // Spot-check the two grains the widget actually sends most.
    expect(parseBucket('900')).toBe(900); // 15-min grid path
    expect(parseBucket('3600')).toBe(3600); // hourly
    expect(parseBucket('604800')).toBe(604800); // 1 week (coarsest)
  });

  it('returns null for absent / off-ladder / garbage values', () => {
    expect(parseBucket(null)).toBeNull(); // absent → server picks
    expect(parseBucket('1800')).toBeNull(); // 30 min: not on the ladder
    expect(parseBucket('0')).toBeNull();
    expect(parseBucket('-3600')).toBeNull();
    expect(parseBucket('abc')).toBeNull();
  });

  it('floors a fractional value before the ladder check (a fraction of a ladder width is on-ladder)', () => {
    // Number('3600.9') = 3600.9 → floor 3600 → on the ladder.
    expect(parseBucket('3600.9')).toBe(3600);
    expect(parseBucket('3600.5')).toBe(3600);
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

  it('WS8: parses an explicit ?bucket= (null when absent / off-ladder)', () => {
    // Absent → null (server picks from the span).
    expect(parseIntervalQuery(new URLSearchParams('fuel=ELECTRIC')).bucket).toBeNull();
    // On-ladder → the value.
    expect(
      parseIntervalQuery(new URLSearchParams('fuel=ELECTRIC&from=2026-06-01&to=2026-06-07&bucket=900'))
        .bucket,
    ).toBe(900);
    expect(parseIntervalQuery(new URLSearchParams('fuel=GAS&bucket=3600')).bucket).toBe(3600);
    // Off-ladder → null (ignored; server picks).
    expect(parseIntervalQuery(new URLSearchParams('fuel=GAS&bucket=1800')).bucket).toBeNull();
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

// Hand-calculated tests for resolveWindowBounds — the PURE helper that turns a
// parsed IntervalWindow into a concrete [from, to] (clock injected) so the history
// route can compute a span for chooseBucket + a SQL range. WS1 rework of #36.
describe('resolveWindowBounds', () => {
  const NOW = Date.UTC(2026, 5, 21, 12, 0, 0); // 2026-06-21T12:00:00Z
  const DAY = 24 * 60 * 60 * 1000;

  it('uses both explicit bounds as-is', () => {
    const from = new Date('2026-06-01T00:00:00.000Z');
    const to = new Date('2026-06-07T23:59:59.999Z');
    const r = resolveWindowBounds({ from, to }, NOW);
    expect(r.from.toISOString()).toBe(from.toISOString());
    expect(r.to.toISOString()).toBe(to.toISOString());
  });

  it('closes a from-only window at `now`', () => {
    const from = new Date('2026-06-01T00:00:00.000Z');
    const r = resolveWindowBounds({ from }, NOW);
    expect(r.from.toISOString()).toBe(from.toISOString());
    expect(r.to.getTime()).toBe(NOW);
  });

  it('opens a to-only window DEFAULT_SINCE_DAYS (30) before `to`', () => {
    const to = new Date('2026-06-30T00:00:00.000Z');
    const r = resolveWindowBounds({ to }, NOW);
    expect(r.to.toISOString()).toBe(to.toISOString());
    expect(r.from.getTime()).toBe(to.getTime() - 30 * DAY);
  });

  it('maps a sinceDays fallback to [now − days, now]', () => {
    const r = resolveWindowBounds({ sinceDays: 14 }, NOW);
    expect(r.to.getTime()).toBe(NOW);
    expect(r.from.getTime()).toBe(NOW - 14 * DAY);
  });

  it('orders crossed bounds defensively (from ≤ to)', () => {
    // from after `now` with no `to` would yield from > to (to defaults to now); the
    // helper swaps them so the span is non-negative.
    const from = new Date(NOW + 5 * DAY);
    const r = resolveWindowBounds({ from }, NOW);
    expect(r.from.getTime()).toBeLessThanOrEqual(r.to.getTime());
    expect(r.from.getTime()).toBe(NOW);
    expect(r.to.getTime()).toBe(NOW + 5 * DAY);
  });
});
