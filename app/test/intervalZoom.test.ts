import { describe, expect, it } from 'vitest';
import {
  msToYmd,
  zoomSpanToRange,
  shouldRefetchZoom,
  clampBrushIndices,
} from '../src/lib/intervalZoom';

// Hand-calculated tests for the PURE interval-zoom helpers (issue #141). The
// helpers map a brushed span to /api/interval day bounds and decide whether a
// zoom warrants a finer-detail refetch. NO infra — pure number/string math.

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('msToYmd (hand-calculated)', () => {
  it('formats an epoch-ms instant as its UTC calendar day', () => {
    // 2026-06-08T18:00:00Z → UTC day 2026-06-08
    expect(msToYmd(Date.parse('2026-06-08T18:00:00Z'))).toBe('2026-06-08');
  });

  it('uses the UTC day even late in a US-eastern evening (no local-day shift)', () => {
    // 2026-06-09T03:30:00Z is still 2026-06-09 in UTC (23:30 the prior day in EDT);
    // we intentionally key off the UTC day to match the route's UTC bounds parsing.
    expect(msToYmd(Date.parse('2026-06-09T03:30:00Z'))).toBe('2026-06-09');
  });

  it('zero-pads single-digit month and day', () => {
    expect(msToYmd(Date.UTC(2026, 0, 5, 12, 0, 0))).toBe('2026-01-05');
  });
});

describe('zoomSpanToRange (hand-calculated)', () => {
  it('maps an ascending span to inclusive UTC day bounds', () => {
    const start = Date.parse('2026-06-08T06:00:00Z');
    const end = Date.parse('2026-06-10T22:00:00Z');
    expect(zoomSpanToRange(start, end)).toEqual({ from: '2026-06-08', to: '2026-06-10' });
  });

  it('orders a backwards drag so from ≤ to', () => {
    const start = Date.parse('2026-06-10T22:00:00Z');
    const end = Date.parse('2026-06-08T06:00:00Z');
    expect(zoomSpanToRange(start, end)).toEqual({ from: '2026-06-08', to: '2026-06-10' });
  });

  it('collapses a within-one-day span to a single day on both bounds', () => {
    const start = Date.parse('2026-06-08T06:00:00Z');
    const end = Date.parse('2026-06-08T20:00:00Z');
    expect(zoomSpanToRange(start, end)).toEqual({ from: '2026-06-08', to: '2026-06-08' });
  });
});

describe('shouldRefetchZoom (hand-calculated)', () => {
  const opts = { maxSpanDays: 14, shrinkRatio: 0.5 };
  // A fetched window of 60 days; pick zoom spans relative to it.
  const fFrom = Date.UTC(2026, 4, 1, 0, 0, 0);
  const fTo = fFrom + 60 * DAY;

  it('refetches a narrow span well inside the fetched window', () => {
    // 3-day zoom: 3 ≤ 14 (span guard) AND 3 ≤ 60*0.5=30 (shrink guard) → refetch.
    const start = fFrom + 10 * DAY;
    const end = start + 3 * DAY;
    expect(shouldRefetchZoom(start, end, fFrom, fTo, opts)).toBe(true);
  });

  it('does NOT refetch a span wider than maxSpanDays even if it shrinks the window', () => {
    // 20-day zoom: 20 > 14 (span guard fails) → no refetch, despite 20 ≤ 30.
    const start = fFrom + 5 * DAY;
    const end = start + 20 * DAY;
    expect(shouldRefetchZoom(start, end, fFrom, fTo, opts)).toBe(false);
  });

  it('does NOT refetch when the zoom is ~the whole fetched window (shrink guard)', () => {
    // Fetched window only 6 days wide; a 5-day zoom: 5 ≤ 14 (span ok) but
    // 5 > 6*0.5=3 (shrink guard fails) → no refetch (no extra detail to gain).
    const narrowFrom = fFrom;
    const narrowTo = fFrom + 6 * DAY;
    const start = narrowFrom + HOUR;
    const end = start + 5 * DAY;
    expect(shouldRefetchZoom(start, end, narrowFrom, narrowTo, opts)).toBe(false);
  });

  it('refetches at exactly the maxSpanDays boundary (inclusive)', () => {
    // 14-day zoom inside a 60-day window: 14 ≤ 14 AND 14 ≤ 30 → refetch.
    const start = fFrom;
    const end = fFrom + 14 * DAY;
    expect(shouldRefetchZoom(start, end, fFrom, fTo, opts)).toBe(true);
  });

  it('returns false for a degenerate (zero-width) zoom span', () => {
    const start = fFrom + 10 * DAY;
    expect(shouldRefetchZoom(start, start, fFrom, fTo, opts)).toBe(false);
  });

  it('returns false for a degenerate fetched window', () => {
    const start = fFrom;
    const end = fFrom + 2 * DAY;
    expect(shouldRefetchZoom(start, end, fFrom, fFrom, opts)).toBe(false);
  });
});

describe('clampBrushIndices (hand-calculated)', () => {
  it('passes through an in-bounds, ordered pair unchanged', () => {
    // 100-point series, selecting indices 10..40 → unchanged.
    expect(clampBrushIndices(10, 40, 100)).toEqual({ startIndex: 10, endIndex: 40 });
  });

  it('clamps an end index past the last point to the last index', () => {
    // 50 points → last index 49; an end of 80 clamps to 49.
    expect(clampBrushIndices(10, 80, 50)).toEqual({ startIndex: 10, endIndex: 49 });
  });

  it('clamps a negative start to 0', () => {
    expect(clampBrushIndices(-5, 20, 50)).toEqual({ startIndex: 0, endIndex: 20 });
  });

  it('orders a reversed pair so start ≤ end', () => {
    expect(clampBrushIndices(40, 10, 100)).toEqual({ startIndex: 10, endIndex: 40 });
  });

  it('spans the whole series for the full-range request', () => {
    // 30 points → [0, 29].
    expect(clampBrushIndices(0, 29, 30)).toEqual({ startIndex: 0, endIndex: 29 });
  });

  it('returns [0,0] for an empty series', () => {
    expect(clampBrushIndices(0, 5, 0)).toEqual({ startIndex: 0, endIndex: 0 });
  });

  it('collapses to the single valid index for a one-point series', () => {
    // len 1 → last index 0; any inputs clamp to [0, 0].
    expect(clampBrushIndices(0, 9, 1)).toEqual({ startIndex: 0, endIndex: 0 });
  });

  it('normalizes non-finite inputs to the endpoints (start→0, end→last)', () => {
    // NaN start → 0; NaN end → last (len-1 = 19).
    expect(clampBrushIndices(NaN, NaN, 20)).toEqual({ startIndex: 0, endIndex: 19 });
  });

  it('rounds fractional indices to the nearest integer', () => {
    expect(clampBrushIndices(2.4, 7.6, 100)).toEqual({ startIndex: 2, endIndex: 8 });
  });
});
