import { describe, expect, it } from 'vitest';
import { DAY_MS, yyyymm, fmtYmd, fmtPortal } from '../src/lib/ngrid/dates';

// Hand-calculated cases for the shared pure scraper date helpers. These pin the
// exact outputs the previously-duplicated copies (collect.ts/portalFetch.ts's
// `yyyymm`, interval.ts/portalFetch.ts's UTC formatters) produced.
describe('DAY_MS', () => {
  it('is exactly one day in milliseconds', () => {
    expect(DAY_MS).toBe(86400000); // 24 * 60 * 60 * 1000
  });
});

describe('yyyymm (hand-calculated)', () => {
  it('extracts YYYYMM from a YYYY-MM-DD string', () => {
    // 2026 * 100 + 6 = 202606.
    expect(yyyymm('2026-06-08')).toBe(202606);
  });

  it('keys off the leading YYYY-MM of an ISO timestamp', () => {
    expect(yyyymm('2024-12-31T23:59:59-05:00')).toBe(202412);
  });

  it('returns 0 for undefined / empty / non-matching input', () => {
    expect(yyyymm(undefined)).toBe(0);
    expect(yyyymm('')).toBe(0);
    expect(yyyymm('not-a-date')).toBe(0);
  });
});

describe('fmtYmd (UTC YYYY-MM-DD, hand-calculated)', () => {
  it('formats a UTC instant', () => {
    // 2026-06-08T00:00:00Z → '2026-06-08'.
    expect(fmtYmd(new Date('2026-06-08T00:00:00Z'))).toBe('2026-06-08');
  });

  it('uses UTC fields (an instant late on Jun 8 ET is still Jun 9 UTC)', () => {
    // 2026-06-08T22:00:00-04:00 === 2026-06-09T02:00:00Z → '2026-06-09'.
    expect(fmtYmd(new Date('2026-06-08T22:00:00-04:00'))).toBe('2026-06-09');
  });

  it('zero-pads month and day', () => {
    expect(fmtYmd(new Date('2026-01-05T12:00:00Z'))).toBe('2026-01-05');
  });
});

describe('fmtPortal (UTC YYYY-MM-DD HH:MM:SS, hand-calculated)', () => {
  it('formats a UTC instant with time', () => {
    expect(fmtPortal(new Date('2026-06-08T13:07:09Z'))).toBe('2026-06-08 13:07:09');
  });

  it('zero-pads all fields and uses UTC', () => {
    // 2026-01-02T03:04:05Z → '2026-01-02 03:04:05'.
    expect(fmtPortal(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02 03:04:05');
  });
});
