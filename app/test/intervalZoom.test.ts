import { describe, expect, it } from 'vitest';
import {
  msToYmd,
  zoomSpanToRange,
  isZoomSelectionSignificant,
  classifyZoomSelection,
  wasDownsampled,
} from '../src/lib/intervalZoom';

// Hand-calculated tests for the PURE interval-zoom helpers (issue #141). The
// helpers map a drag-selected span to /api/interval day bounds and decide whether
// a drag is deliberate enough to zoom (vs an accidental click). NO infra — pure
// number/string math.

const HOUR = 3_600_000;
const MINUTE = 60_000;

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

describe('isZoomSelectionSignificant (hand-calculated)', () => {
  // Minimum deliberate-drag span: 30 minutes (two adjacent 15-min points jittered
  // under a click should NOT zoom; a genuine drag across ≥30 min does).
  const MIN = 30 * MINUTE;
  const base = Date.UTC(2026, 5, 8, 6, 0, 0);

  it('zooms a deliberate multi-hour drag across distinct indices', () => {
    // indices 10≠40, span 6h ≥ 30min → significant.
    expect(isZoomSelectionSignificant(10, 40, base, base + 6 * HOUR, MIN)).toBe(true);
  });

  it('rejects a click (same index on down and up)', () => {
    // A single click lands both endpoints on index 25 → not significant even if
    // the ms happened to differ.
    expect(isZoomSelectionSignificant(25, 25, base, base + HOUR, MIN)).toBe(false);
  });

  it('rejects a sub-minimum jitter-drag across adjacent points', () => {
    // indices differ (12 vs 13) but only 15 min apart < 30 min → not significant.
    expect(isZoomSelectionSignificant(12, 13, base, base + 15 * MINUTE, MIN)).toBe(false);
  });

  it('zooms at exactly the minimum span (inclusive boundary)', () => {
    // indices differ and span == 30 min == MIN → significant.
    expect(isZoomSelectionSignificant(12, 14, base, base + 30 * MINUTE, MIN)).toBe(true);
  });

  it('is order-independent (a backwards drag is still significant)', () => {
    // end index < start index, end ms < start ms; abs span 6h ≥ 30min → significant.
    expect(isZoomSelectionSignificant(40, 10, base + 6 * HOUR, base, MIN)).toBe(true);
  });

  it('rejects non-finite endpoints', () => {
    expect(isZoomSelectionSignificant(NaN, 10, base, base + HOUR, MIN)).toBe(false);
    expect(isZoomSelectionSignificant(0, 10, NaN, base + HOUR, MIN)).toBe(false);
  });
});

describe('classifyZoomSelection (hand-calculated)', () => {
  // Floor of 1 hour (the component's MIN_ZOOM_SPAN_MS): a deliberate drag tighter
  // than this is refused; a click stays silent; a wider drag zooms.
  const MIN = HOUR;
  const base = Date.UTC(2026, 5, 8, 6, 0, 0);

  it('classifies a click (same index) as "click" regardless of ms', () => {
    // Both endpoints on index 25 → a click, even if the reported ms differ.
    expect(classifyZoomSelection(25, 25, base, base + 6 * HOUR, MIN)).toBe('click');
  });

  it('classifies a deliberate drag below the floor as "too-small"', () => {
    // Distinct points (12 vs 13) but only 15 min apart < 1h floor → refused.
    expect(classifyZoomSelection(12, 13, base, base + 15 * MINUTE, MIN)).toBe('too-small');
  });

  it('classifies a productive drag (span ≥ floor) as "zoom"', () => {
    // Distinct indices, 6h span ≥ 1h → zoom.
    expect(classifyZoomSelection(10, 40, base, base + 6 * HOUR, MIN)).toBe('zoom');
  });

  it('treats exactly the floor span as "zoom" (inclusive boundary)', () => {
    // Distinct indices, span == 1h == MIN → zoom (boundary is productive).
    expect(classifyZoomSelection(12, 14, base, base + HOUR, MIN)).toBe('zoom');
  });

  it('is order-independent (a backwards drag classifies by absolute span)', () => {
    // end before start, 6h apart → still a zoom.
    expect(classifyZoomSelection(40, 10, base + 6 * HOUR, base, MIN)).toBe('zoom');
    // backwards but 15 min apart → too-small.
    expect(classifyZoomSelection(13, 12, base + 15 * MINUTE, base, MIN)).toBe('too-small');
  });

  it('treats non-finite endpoints as a silent click', () => {
    expect(classifyZoomSelection(NaN, 10, base, base + HOUR, MIN)).toBe('click');
    expect(classifyZoomSelection(0, 10, NaN, base + HOUR, MIN)).toBe('click');
  });
});

describe('wasDownsampled (hand-calculated)', () => {
  // Mirrors downsampleByTime's gate: reduced exactly when raw rows > cap.
  it('is true when there are more raw rows than the cap', () => {
    expect(wasDownsampled(601, 600)).toBe(true);
    expect(wasDownsampled(17_520, 600)).toBe(true);
  });

  it('is false at or below the cap (returned as-is, finest detail)', () => {
    expect(wasDownsampled(600, 600)).toBe(false); // exactly at the cap
    expect(wasDownsampled(42, 600)).toBe(false);
    expect(wasDownsampled(0, 600)).toBe(false);
  });

  it('is false when the cap disables downsampling (≤ 0)', () => {
    expect(wasDownsampled(1000, 0)).toBe(false);
    expect(wasDownsampled(1000, -5)).toBe(false);
  });

  it('is false for non-finite inputs', () => {
    expect(wasDownsampled(NaN, 600)).toBe(false);
    expect(wasDownsampled(1000, NaN)).toBe(false);
  });
});
