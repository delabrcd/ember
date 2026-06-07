import { describe, expect, it } from 'vitest';
import { ymFromDate, ymFromParts, isoDate, ymLabel, ymAddMonths } from '../src/lib/ym';

// These mirror the behaviour of the helpers that used to live inline in
// queries.ts / range.ts / series.ts / prediction.ts / ngrid/verify.ts /
// weather/sync.ts / notifyFormat.ts before they were consolidated here.

describe('ymFromDate (Date → YYYYMM, UTC)', () => {
  it('uses the UTC year/month, not local time', () => {
    expect(ymFromDate(new Date('2024-05-17T00:00:00Z'))).toBe(202405);
    expect(ymFromDate(new Date('2024-01-01T00:00:00Z'))).toBe(202401);
    expect(ymFromDate(new Date('2024-12-31T00:00:00Z'))).toBe(202412);
  });

  it('reads the UTC instant even near a day/month boundary', () => {
    // 2024-12-31T23:30Z is still December in UTC.
    expect(ymFromDate(new Date('2024-12-31T23:30:00Z'))).toBe(202412);
    // 2025-01-01T00:30Z is January in UTC.
    expect(ymFromDate(new Date('2025-01-01T00:30:00Z'))).toBe(202501);
  });
});

describe('ymFromParts ((year, month) → YYYYMM)', () => {
  it('composes a ym from a year and a 1-based month', () => {
    expect(ymFromParts(2024, 5)).toBe(202405);
    expect(ymFromParts(2024, 12)).toBe(202412);
    expect(ymFromParts(2024, 1)).toBe(202401);
  });
});

describe('isoDate (Date → YYYY-MM-DD, UTC)', () => {
  it('matches .toISOString().slice(0, 10)', () => {
    expect(isoDate(new Date('2024-05-17T00:00:00Z'))).toBe('2024-05-17');
    expect(isoDate(new Date('2024-01-09T12:34:56Z'))).toBe('2024-01-09');
  });

  it('reports the UTC calendar day for a late-day instant', () => {
    expect(isoDate(new Date('2024-12-31T23:59:59Z'))).toBe('2024-12-31');
  });
});

describe('ymLabel (ym → YYYY-MM)', () => {
  it('zero-pads single-digit months', () => {
    expect(ymLabel(202405)).toBe('2024-05');
    expect(ymLabel(202401)).toBe('2024-01');
    expect(ymLabel(202412)).toBe('2024-12');
  });
});

describe('ymAddMonths (shift a ym by N calendar months)', () => {
  it('adds one month, rolling Dec → Jan', () => {
    expect(ymAddMonths(202405, 1)).toBe(202406);
    expect(ymAddMonths(202412, 1)).toBe(202501);
    expect(ymAddMonths(202401, 1)).toBe(202402);
  });

  it('subtracts months across a year boundary', () => {
    expect(ymAddMonths(202412, -11)).toBe(202401); // 12-mo window ending Dec → starts Jan
    expect(ymAddMonths(202401, -1)).toBe(202312);
    expect(ymAddMonths(202403, -5)).toBe(202310);
    expect(ymAddMonths(202412, -23)).toBe(202301); // 24-mo window
  });

  it('is a no-op for a zero delta', () => {
    expect(ymAddMonths(202407, 0)).toBe(202407);
  });

  it('handles multi-year jumps in both directions', () => {
    expect(ymAddMonths(202401, 13)).toBe(202502);
    expect(ymAddMonths(202401, -13)).toBe(202212);
  });
});
