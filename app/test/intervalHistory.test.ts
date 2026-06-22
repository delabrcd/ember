import { describe, expect, it } from 'vitest';
import { toHistoryPoints, formatHistoryLabel, formatGrain } from '../src/lib/intervalHistory';
import type { IntervalProfileRow } from '../src/lib/intervalProfile';

// Hand-calculated tests for the PURE intervalHistory shapers (issue #121 part 2).
// All instants are written with explicit UTC offsets so the UTC instant is
// unambiguous. America/New_York in June is EDT (-04:00 = UTC-4).

describe('formatHistoryLabel (hand-calculated)', () => {
  it('formats an EDT instant as "Mon D HH:MM" (24-h, local wall-clock)', () => {
    // 2026-06-08 18:00 UTC = 2026-06-08 14:00 EDT
    const label = formatHistoryLabel(new Date('2026-06-08T18:00:00Z').getTime());
    expect(label).toBe('Jun 8 14:00');
  });

  it('formats a midnight UTC instant correctly (handles Intl "24" → "00" edge case)', () => {
    // 2026-06-09T04:00:00Z = 2026-06-09 00:00 EDT (midnight local)
    const label = formatHistoryLabel(new Date('2026-06-09T04:00:00Z').getTime());
    // Should be "Jun 9 00:00", NOT "Jun 9 24:00"
    expect(label).not.toContain('24:');
    expect(label).toMatch(/^Jun 9 00:00$/);
  });

  it('formats a late-night UTC instant that crosses the local day boundary', () => {
    // 2026-06-09T03:30:00Z = 2026-06-08 23:30 EDT
    const label = formatHistoryLabel(new Date('2026-06-09T03:30:00Z').getTime());
    expect(label).toBe('Jun 8 23:30');
  });

  it('formats a 15-minute interval start correctly', () => {
    // 2026-06-08T17:15:00Z = 2026-06-08 13:15 EDT
    const label = formatHistoryLabel(new Date('2026-06-08T17:15:00Z').getTime());
    expect(label).toBe('Jun 8 13:15');
  });
});

describe('toHistoryPoints (hand-calculated)', () => {
  function row(iso: string, quantity: number, intervalSeconds = 3600): IntervalProfileRow {
    return { intervalStart: iso, intervalSeconds, quantity };
  }

  it('maps a single row to one point with correct ts, label, value', () => {
    // 2026-06-08T18:00:00Z = 2026-06-08 14:00 EDT
    const rows = [row('2026-06-08T18:00:00Z', 1.234)];
    const pts = toHistoryPoints(rows);
    expect(pts).toHaveLength(1);
    expect(pts[0].ts).toBe(new Date('2026-06-08T18:00:00Z').getTime());
    expect(pts[0].label).toBe('Jun 8 14:00');
    expect(pts[0].value).toBeCloseTo(1.234, 10);
  });

  it('returns points sorted ascending by timestamp regardless of input order', () => {
    const rows = [
      row('2026-06-08T20:00:00Z', 2.0), // later
      row('2026-06-08T18:00:00Z', 1.0), // earlier
      row('2026-06-08T19:00:00Z', 1.5), // middle
    ];
    const pts = toHistoryPoints(rows);
    expect(pts).toHaveLength(3);
    expect(pts[0].ts).toBeLessThan(pts[1].ts);
    expect(pts[1].ts).toBeLessThan(pts[2].ts);
    expect(pts[0].value).toBeCloseTo(1.0, 10);
    expect(pts[1].value).toBeCloseTo(1.5, 10);
    expect(pts[2].value).toBeCloseTo(2.0, 10);
  });

  it('drops rows with non-finite quantity and keeps the rest', () => {
    const rows = [
      row('2026-06-08T18:00:00Z', Number.NaN),
      row('2026-06-08T19:00:00Z', 3.5),
      row('2026-06-08T20:00:00Z', Infinity),
    ];
    const pts = toHistoryPoints(rows);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBeCloseTo(3.5, 10);
  });

  it('drops rows with unparseable timestamps and keeps the rest', () => {
    const rows: IntervalProfileRow[] = [
      { intervalStart: 'not-a-date', intervalSeconds: 3600, quantity: 1 },
      { intervalStart: '2026-06-08T18:00:00Z', intervalSeconds: 3600, quantity: 2 },
    ];
    const pts = toHistoryPoints(rows);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBeCloseTo(2, 10);
  });

  it('returns [] for empty input', () => {
    expect(toHistoryPoints([])).toEqual([]);
  });

  it('does NOT fabricate zero points for gaps — absent rows = absent points', () => {
    // Only two rows with a gap between them. The output has exactly 2 points —
    // no invented zero at the gap — so the chart renders a line break.
    const rows = [
      row('2026-06-08T12:00:00Z', 1.0),
      // gap: 13:00 UTC is absent
      row('2026-06-08T14:00:00Z', 2.0),
    ];
    const pts = toHistoryPoints(rows);
    expect(pts).toHaveLength(2);
    expect(pts[0].value).toBeCloseTo(1.0, 10);
    expect(pts[1].value).toBeCloseTo(2.0, 10);
    // Timestamps confirm: no fabricated entry at 13:00 UTC
    const tsBetween = new Date('2026-06-08T13:00:00Z').getTime();
    expect(pts.some((p) => p.ts === tsBetween)).toBe(false);
  });

  it('accepts Date objects for intervalStart as well as strings', () => {
    const rows: IntervalProfileRow[] = [
      { intervalStart: new Date('2026-06-08T18:00:00Z'), intervalSeconds: 900, quantity: 0.25 },
    ];
    const pts = toHistoryPoints(rows);
    expect(pts).toHaveLength(1);
    expect(pts[0].value).toBeCloseTo(0.25, 10);
    expect(pts[0].label).toBe('Jun 8 14:00');
  });

  it('produces correct labels and ts for 15-min interval rows', () => {
    // Four 15-min reads at 13:00, 13:15, 13:30, 13:45 EDT
    const rows: IntervalProfileRow[] = [
      { intervalStart: '2026-06-08T17:00:00Z', intervalSeconds: 900, quantity: 0.1 },
      { intervalStart: '2026-06-08T17:15:00Z', intervalSeconds: 900, quantity: 0.2 },
      { intervalStart: '2026-06-08T17:30:00Z', intervalSeconds: 900, quantity: 0.3 },
      { intervalStart: '2026-06-08T17:45:00Z', intervalSeconds: 900, quantity: 0.4 },
    ];
    const pts = toHistoryPoints(rows);
    expect(pts).toHaveLength(4);
    expect(pts.map((p) => p.label)).toEqual(['Jun 8 13:00', 'Jun 8 13:15', 'Jun 8 13:30', 'Jun 8 13:45']);
    expect(pts.map((p) => p.value)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

describe('formatGrain (hand-calculated)', () => {
  it('names the exact buckets chooseBucket emits', () => {
    // The standard ladder — each value is a width chooseBucket actually picks.
    expect(formatGrain(900)).toBe('15-min');
    expect(formatGrain(3600)).toBe('hourly');
    expect(formatGrain(21600)).toBe('6-hour');
    expect(formatGrain(86400)).toBe('daily');
    expect(formatGrain(604800)).toBe('weekly');
  });

  it('falls back to a derived unit label for an off-ladder bucket', () => {
    expect(formatGrain(7200)).toBe('2-hour'); // 7200 / 3600
    expect(formatGrain(172800)).toBe('2-day'); // 172800 / 86400
    expect(formatGrain(1800)).toBe('30-min'); // 1800 / 60
    expect(formatGrain(45)).toBe('45s'); // sub-minute → raw seconds
  });

  it('returns "" for absent / non-finite / non-positive grain (so the caller omits it)', () => {
    expect(formatGrain(undefined)).toBe('');
    expect(formatGrain(null)).toBe('');
    expect(formatGrain(Number.NaN)).toBe('');
    expect(formatGrain(0)).toBe('');
    expect(formatGrain(-3600)).toBe('');
  });
});
