import { describe, expect, it } from 'vitest';
import { formatPeakReadout } from '../src/lib/intervalProfile';

// Hand-calculated tests for the PURE peak-demand readout formatter (issue #150).
// The string is `Peak <value> <unit> · <when>` where the value uses 2 decimals
// below 10 and 1 at/above 10, and `<when>` renders the UTC intervalStart in the
// account's local clock (America/New_York, fixed). Each `when` below is worked out
// by hand from the UTC instant + the EDT/EST offset; the value formatting is worked
// out from the toFixed rule.

describe('formatPeakReadout (hand-calculated)', () => {
  it('formats a sub-10 electric peak with 2 decimals, EDT clock', () => {
    // 2026-06-07T23:00:00Z is summer → EDT (-04:00) → 19:00 local = 7 PM.
    // 2026-06-07 (UTC) is a Sunday; the local instant is still Sunday Jun 7.
    // value 4.21 < 10 → toFixed(2) = "4.21".
    expect(
      formatPeakReadout({ value: 4.21, intervalStart: '2026-06-07T23:00:00Z' }, 'kW'),
    ).toBe('Peak 4.21 kW · Sun, Jun 7, 7 PM');
  });

  it('formats a ≥10 peak with 1 decimal', () => {
    // 12.5 ≥ 10 → toFixed(1) = "12.5".
    expect(
      formatPeakReadout({ value: 12.5, intervalStart: '2026-06-07T23:00:00Z' }, 'kW'),
    ).toBe('Peak 12.5 kW · Sun, Jun 7, 7 PM');
  });

  it('rounds within the sub-10 (2-decimal) band — 9.999 → "10.00"', () => {
    // 9.999 < 10 → toFixed(2) rounds to "10.00" (the 2-decimal band is chosen by
    // the RAW value, not the rounded one).
    expect(
      formatPeakReadout({ value: 9.999, intervalStart: '2026-06-07T23:00:00Z' }, 'kW'),
    ).toBe('Peak 10.00 kW · Sun, Jun 7, 7 PM');
  });

  it('uses EST in winter and the gas power unit', () => {
    // 2026-01-15T10:00:00Z is winter → EST (-05:00) → 05:00 local = 5 AM.
    // 2026-01-15 is a Thursday. value 0.5 < 10 → "0.50". Gas unit = therms/h.
    expect(
      formatPeakReadout({ value: 0.5, intervalStart: '2026-01-15T10:00:00Z' }, 'therms/h'),
    ).toBe('Peak 0.50 therms/h · Thu, Jan 15, 5 AM');
  });

  it('accepts a Date intervalStart (noon EDT)', () => {
    // 2026-06-08T16:30:00Z → EDT → 12:30 → the hour-only format reads "12 PM".
    // 2026-06-08 is a Monday. value 3 < 10 → "3.00".
    expect(
      formatPeakReadout({ value: 3, intervalStart: new Date('2026-06-08T16:30:00Z') }, 'kW'),
    ).toBe('Peak 3.00 kW · Mon, Jun 8, 12 PM');
  });

  it('returns null for a null/undefined peak (no readout)', () => {
    expect(formatPeakReadout(null, 'kW')).toBeNull();
    expect(formatPeakReadout(undefined, 'kW')).toBeNull();
  });
});
