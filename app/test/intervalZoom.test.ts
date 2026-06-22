import { describe, expect, it } from 'vitest';
import {
  msToYmd,
  zoomSpanToRange,
  isZoomSelectionSignificant,
  classifyZoomSelection,
  wasDownsampled,
  zoomWindowAroundCenter,
  panWindow,
  navCursor,
  viewDomainFor,
  pixelPanDeltaMs,
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

describe('zoomWindowAroundCenter (hand-calculated, WS5)', () => {
  // A clean 100-hour global window so fractions/spans are easy to verify by hand.
  // bounds: [0, 100h]; an interior window [20h, 60h] (span 40h).
  const B_LO = 0;
  const B_HI = 100 * HOUR;
  const LO = 20 * HOUR;
  const HI = 60 * HOUR;
  const MIN = HOUR; // 1h floor (matches the component MIN_ZOOM_SPAN_MS)

  it('zoom-IN keeps the center at the same fractional position', () => {
    // center at 30h is 10h into a 40h window → frac = 0.25.
    // factor 0.5 → newSpan 20h; newLo = 30h - 0.25*20h = 30h - 5h = 25h; newHi = 45h.
    // Verify 30h is still 0.25 of the way through [25h, 45h]: (30-25)/20 = 0.25. ✓
    const r = zoomWindowAroundCenter(LO, HI, 30 * HOUR, 0.5, B_LO, B_HI, MIN);
    expect(r.fromMs).toBe(25 * HOUR);
    expect(r.toMs).toBe(45 * HOUR);
    expect((30 * HOUR - r.fromMs) / (r.toMs - r.fromMs)).toBeCloseTo(0.25, 10);
  });

  it('zoom-OUT clamps to the global bounds and stops growing (no overshoot)', () => {
    // window [20h,60h] span 40h; factor 4 → desired 160h > 100h bound span → capped
    // to 100h, which IS the full bounds → collapses to exactly [0, 100h].
    const r = zoomWindowAroundCenter(LO, HI, 40 * HOUR, 4, B_LO, B_HI, MIN);
    expect(r.fromMs).toBe(B_LO);
    expect(r.toMs).toBe(B_HI);
  });

  it('zoom-OUT that hits ONE wall slides inward keeping the new span', () => {
    // window [10h,30h] span 20h, center 12h (frac 0.1). factor 2 → newSpan 40h.
    // newLo = 12h - 0.1*40h = 12h - 4h = 8h; newHi = 48h. 8h ≥ 0 and 48h ≤ 100h,
    // so no wall hit — span preserved at 40h.
    const r = zoomWindowAroundCenter(10 * HOUR, 30 * HOUR, 12 * HOUR, 2, B_LO, B_HI, MIN);
    expect(r.toMs - r.fromMs).toBe(40 * HOUR);
    expect(r.fromMs).toBe(8 * HOUR);
    expect(r.toMs).toBe(48 * HOUR);
  });

  it('zoom-OUT near the left wall pins the low edge to the bound (slides, keeps span)', () => {
    // window [5h,15h] span 10h, center 6h (frac 0.1). factor 3 → newSpan 30h.
    // newLo = 6h - 0.1*30h = 6h - 3h = 3h; newHi = 33h. 3h ≥ 0 so still inside —
    // no clamp. Tighten: use center 5h (frac 0) → newLo = 5h - 0 = 5h… so instead
    // push the window against the wall: window [2h,12h] span 10h, center 3h frac 0.1,
    // factor 4 → newSpan 40h; newLo = 3h - 0.1*40h = 3h - 4h = -1h < 0 → clamp low
    // to 0, slide hi to 0 + 40h = 40h (span preserved).
    const r = zoomWindowAroundCenter(2 * HOUR, 12 * HOUR, 3 * HOUR, 4, B_LO, B_HI, MIN);
    expect(r.fromMs).toBe(B_LO);
    expect(r.toMs - r.fromMs).toBe(40 * HOUR);
    expect(r.toMs).toBe(40 * HOUR);
  });

  it('respects the min-span floor on a deep zoom-in', () => {
    // window [20h,60h] span 40h; factor 0.01 → desired 0.4h < 1h floor → floored to 1h.
    // center 40h frac 0.5 → newLo = 40h - 0.5*1h = 39.5h; newHi = 40.5h (span 1h).
    const r = zoomWindowAroundCenter(LO, HI, 40 * HOUR, 0.01, B_LO, B_HI, MIN);
    expect(r.toMs - r.fromMs).toBe(MIN);
    expect(r.fromMs).toBe(40 * HOUR - 0.5 * HOUR);
    expect(r.toMs).toBe(40 * HOUR + 0.5 * HOUR);
  });

  it('returns the ordered input window unchanged on malformed input', () => {
    expect(zoomWindowAroundCenter(60 * HOUR, 20 * HOUR, NaN, 0.5, B_LO, B_HI, MIN)).toEqual({
      fromMs: 20 * HOUR,
      toMs: 60 * HOUR,
    });
  });
});

describe('panWindow (hand-calculated, WS5)', () => {
  const B_LO = 0;
  const B_HI = 100 * HOUR;

  it('shifts the window right by the full delta when it fits', () => {
    // [20h,40h] + 10h → [30h,50h]; both inside [0,100h].
    expect(panWindow(20 * HOUR, 40 * HOUR, 10 * HOUR, B_LO, B_HI)).toEqual({
      fromMs: 30 * HOUR,
      toMs: 50 * HOUR,
    });
  });

  it('shifts left by the full delta when it fits', () => {
    expect(panWindow(40 * HOUR, 60 * HOUR, -10 * HOUR, B_LO, B_HI)).toEqual({
      fromMs: 30 * HOUR,
      toMs: 50 * HOUR,
    });
  });

  it('reduces the shift at the RIGHT wall (clamps, preserves span)', () => {
    // [80h,95h] span 15h; +20h would push hi to 115h > 100h → max right travel is
    // (100-95)=5h → window slides to [85h,100h].
    expect(panWindow(80 * HOUR, 95 * HOUR, 20 * HOUR, B_LO, B_HI)).toEqual({
      fromMs: 85 * HOUR,
      toMs: 100 * HOUR,
    });
  });

  it('reduces the shift at the LEFT wall (clamps, preserves span)', () => {
    // [5h,25h] span 20h; -30h would push lo to -25h → max left travel is (0-5)=-5h →
    // window slides to [0h,20h].
    expect(panWindow(5 * HOUR, 25 * HOUR, -30 * HOUR, B_LO, B_HI)).toEqual({
      fromMs: 0,
      toMs: 20 * HOUR,
    });
  });

  it('cannot pan a window that already spans the bounds (pins to bounds)', () => {
    expect(panWindow(0, 100 * HOUR, 10 * HOUR, B_LO, B_HI)).toEqual({
      fromMs: 0,
      toMs: 100 * HOUR,
    });
  });

  it('returns the ordered input window on malformed input', () => {
    expect(panWindow(40 * HOUR, 20 * HOUR, NaN, B_LO, B_HI)).toEqual({
      fromMs: 20 * HOUR,
      toMs: 40 * HOUR,
    });
  });

  // WS11: the wheel-pan bug was the impure shell reading a STALE window (the `zoom`
  // closure) each notch — a stale read that fell back to the full bounds made the span
  // JUMP, distorting (widening) the window instead of sliding it. The fix reads the
  // FRESH committed window per notch and re-pans from it. These tests prove the PURE
  // contract the fix relies on: feeding panWindow's OWN output back in (the
  // "accumulate from the latest committed window" loop the widget now does via
  // curWindowRef) translates with a CONSTANT span every notch, and at the global edge
  // it clamps the SHIFT, never the span.
  describe('WS11 repeated-pan accumulation (constant span, shift-clamped at the edge)', () => {
    // A zoomed-in 10h window sitting interior of the 100h global bounds.
    const WIN_SPAN = 10 * HOUR;
    // One wheel notch = WHEEL_PAN_FRACTION (0.12) of the CURRENT span (12% of 10h = 1.2h).
    const NOTCH = -0.12 * WIN_SPAN; // negative = pan LEFT (earlier)

    it('keeps a CONSTANT span across many left-pan notches (no widen/compress)', () => {
      let win = { fromMs: 60 * HOUR, toMs: 60 * HOUR + WIN_SPAN }; // [60h,70h]
      const spans: number[] = [];
      // Five notches, each re-panning from the PRIOR output (the fixed accumulate loop).
      for (let i = 0; i < 5; i++) {
        win = panWindow(win.fromMs, win.toMs, NOTCH, B_LO, B_HI);
        spans.push(win.toMs - win.fromMs);
      }
      // Every notch preserved the 10h span exactly — the distortion (span growth) is gone.
      for (const s of spans) expect(s).toBe(WIN_SPAN);
      // And it actually MOVED left by 5 notches (1.2h each = 6h): [54h,64h].
      expect(win.fromMs).toBe(60 * HOUR - 5 * 1.2 * HOUR);
      expect(win.toMs).toBe(70 * HOUR - 5 * 1.2 * HOUR);
    });

    it('clamps the SHIFT (not the span) when repeated pans reach the LEFT wall', () => {
      // Start near the left wall so a few notches run into it. [3h,13h], span 10h.
      let win = { fromMs: 3 * HOUR, toMs: 13 * HOUR };
      for (let i = 0; i < 10; i++) {
        win = panWindow(win.fromMs, win.toMs, NOTCH, B_LO, B_HI);
      }
      // Pinned at the left wall: lo === 0, span STILL 10h (the wall reduced the shift,
      // never the span). The right edge is NOT dragged past its proportional spot.
      expect(win.fromMs).toBe(B_LO);
      expect(win.toMs - win.fromMs).toBe(WIN_SPAN);
      expect(win.toMs).toBe(WIN_SPAN);
    });

    it('clamps the SHIFT (not the span) when repeated pans reach the RIGHT wall', () => {
      const RIGHT_NOTCH = +0.12 * WIN_SPAN; // pan RIGHT (later)
      let win = { fromMs: 87 * HOUR, toMs: 97 * HOUR }; // span 10h, near the right wall
      for (let i = 0; i < 10; i++) {
        win = panWindow(win.fromMs, win.toMs, RIGHT_NOTCH, B_LO, B_HI);
      }
      // Pinned at the right wall: hi === 100h, span STILL 10h.
      expect(win.toMs).toBe(B_HI);
      expect(win.toMs - win.fromMs).toBe(WIN_SPAN);
      expect(win.fromMs).toBe(B_HI - WIN_SPAN);
    });

    it('a stale FULL-bounds read (the OLD bug) pins and cannot pan — the fix avoids it', () => {
      // The old code, on a stale read, could fall back to the FULL global window.
      // Re-panning from there does nothing (a full-bounds window has no travel) — which
      // is exactly why the view looked "stuck/distorted at the right edge". The fix never
      // feeds the full bounds in mid-pan; it feeds the fresh zoomed window. We assert the
      // degenerate full-bounds input is inert so the fix's reliance on a NON-full input
      // is explicit.
      const full = panWindow(B_LO, B_HI, NOTCH, B_LO, B_HI);
      expect(full).toEqual({ fromMs: B_LO, toMs: B_HI });
    });
  });
});

describe('pixelPanDeltaMs (hand-calculated, WS10)', () => {
  // Proportional: deltaPx / plotWidthPx of the span. With a 1000px plot over a
  // 10-hour (36_000_000 ms) span, a 100px drag = 1/10 of the plot = 1/10 of the
  // span = 1 hour = 3_600_000 ms. Worked by hand: (100/1000)*36_000_000.
  it('maps a fractional pixel delta to the same fraction of the span', () => {
    expect(pixelPanDeltaMs(100, 1000, 10 * HOUR)).toBe(HOUR);
  });

  // A full-plot drag (deltaPx === plotWidthPx) shifts by the whole span.
  it('maps a full-width drag to the full span', () => {
    expect(pixelPanDeltaMs(800, 800, 6 * HOUR)).toBe(6 * HOUR);
  });

  // Negative pixel delta → negative ms (direction is the caller's; this is linear).
  it('preserves sign (a leftward pixel delta is a negative ms delta)', () => {
    expect(pixelPanDeltaMs(-250, 1000, 8 * HOUR)).toBe(-2 * HOUR);
  });

  // Zero drag → zero shift.
  it('returns 0 for a zero pixel delta', () => {
    expect(pixelPanDeltaMs(0, 1000, 10 * HOUR)).toBe(0);
  });

  // Guard: a non-positive plot width can't map pixels to ms → 0 (no pan), not Inf.
  it('returns 0 when plotWidthPx is zero or negative', () => {
    expect(pixelPanDeltaMs(100, 0, 10 * HOUR)).toBe(0);
    expect(pixelPanDeltaMs(100, -50, 10 * HOUR)).toBe(0);
  });

  // Guard: non-finite inputs → 0.
  it('returns 0 for non-finite inputs', () => {
    expect(pixelPanDeltaMs(NaN, 1000, HOUR)).toBe(0);
    expect(pixelPanDeltaMs(100, NaN, HOUR)).toBe(0);
    expect(pixelPanDeltaMs(100, 1000, NaN)).toBe(0);
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

describe('viewDomainFor (WS7 live numeric-axis domain, hand-calculated)', () => {
  const B_LO = 1_000;
  const B_HI = 1_000 + 100 * HOUR;

  it('uses a valid ordered zoom window verbatim (ignores the bounds)', () => {
    // A real zoom span [20h,60h] (offset from B_LO) is returned as-is — it's already
    // clamped by panWindow/zoomWindowAroundCenter, so viewDomainFor trusts it.
    const zf = B_LO + 20 * HOUR;
    const zt = B_LO + 60 * HOUR;
    expect(viewDomainFor(zf, zt, B_LO, B_HI)).toEqual({ fromMs: zf, toMs: zt });
  });

  it('falls back to the (ordered) global bounds when there is no zoom', () => {
    // null zoom → follow the global window.
    expect(viewDomainFor(null, null, B_LO, B_HI)).toEqual({ fromMs: B_LO, toMs: B_HI });
    // bounds given out of order are normalized lo..hi.
    expect(viewDomainFor(null, null, B_HI, B_LO)).toEqual({ fromMs: B_LO, toMs: B_HI });
  });

  it('ignores a degenerate / non-finite zoom and falls back to bounds', () => {
    // from === to (zero span) is not a usable zoom → bounds.
    expect(viewDomainFor(B_LO + 5 * HOUR, B_LO + 5 * HOUR, B_LO, B_HI)).toEqual({
      fromMs: B_LO,
      toMs: B_HI,
    });
    // from > to (inverted) → not used → bounds.
    expect(viewDomainFor(B_LO + 60 * HOUR, B_LO + 20 * HOUR, B_LO, B_HI)).toEqual({
      fromMs: B_LO,
      toMs: B_HI,
    });
    // NaN endpoints → bounds.
    expect(viewDomainFor(Number.NaN, B_LO + 20 * HOUR, B_LO, B_HI)).toEqual({
      fromMs: B_LO,
      toMs: B_HI,
    });
  });

  it('returns null when neither a zoom nor usable bounds exist (auto-fit)', () => {
    // No zoom and non-finite bounds (a non-dashboard caller) → null → Recharts
    // auto-fits the numeric domain to the data.
    expect(viewDomainFor(null, null, Number.NaN, Number.NaN)).toBeNull();
    // Degenerate bounds (lo === hi) are also unusable → null.
    expect(viewDomainFor(null, null, 5_000, 5_000)).toBeNull();
  });

  it('prefers a valid zoom even when the bounds are unusable', () => {
    // A real zoom should win regardless of the bounds' validity.
    const zf = 10 * HOUR;
    const zt = 30 * HOUR;
    expect(viewDomainFor(zf, zt, Number.NaN, Number.NaN)).toEqual({ fromMs: zf, toMs: zt });
  });
});

describe('navCursor (WS6 modifier → cursor, hand-enumerated)', () => {
  // The full decision table. Precedence: not-focused wins (default); then Ctrl
  // (grabbing while dragging, else grab); then Shift (ew-resize); else crosshair.
  it('is default when NOT focused AND NOT hovering, regardless of modifiers', () => {
    // `hovering` omitted ⇒ false (WS6 back-compat). An unfocused, un-hovered chart is
    // never armed: page-scroll past it stays free and it doesn't look interactive.
    expect(navCursor({ focused: false, ctrlDown: false, shiftDown: false, ctrlDragging: false })).toBe('default');
    expect(navCursor({ focused: false, ctrlDown: true, shiftDown: false, ctrlDragging: false })).toBe('default');
    expect(navCursor({ focused: false, ctrlDown: false, shiftDown: true, ctrlDragging: false })).toBe('default');
    // Even a (stale) ctrlDragging flag can't arm an unfocused, un-hovered chart.
    expect(navCursor({ focused: false, ctrlDown: true, shiftDown: true, ctrlDragging: true })).toBe('default');
  });

  it('is crosshair when focused with no modifier (plain drag still zoom-selects)', () => {
    expect(navCursor({ focused: true, ctrlDown: false, shiftDown: false, ctrlDragging: false })).toBe('crosshair');
  });

  it('is grab when focused + Ctrl held but not yet dragging', () => {
    expect(navCursor({ focused: true, ctrlDown: true, shiftDown: false, ctrlDragging: false })).toBe('grab');
  });

  it('is grabbing when focused + Ctrl held AND actively dragging the viewport', () => {
    expect(navCursor({ focused: true, ctrlDown: true, shiftDown: false, ctrlDragging: true })).toBe('grabbing');
  });

  it('is ew-resize when focused + Shift held (the shift+wheel pan)', () => {
    expect(navCursor({ focused: true, ctrlDown: false, shiftDown: true, ctrlDragging: false })).toBe('ew-resize');
  });

  it('lets Ctrl win over Shift when both are held (mirrors handler precedence)', () => {
    expect(navCursor({ focused: true, ctrlDown: true, shiftDown: true, ctrlDragging: false })).toBe('grab');
    expect(navCursor({ focused: true, ctrlDown: true, shiftDown: true, ctrlDragging: true })).toBe('grabbing');
  });

  it('ignores ctrlDragging when Ctrl is not held (can only grab/grabbing under Ctrl)', () => {
    // A dangling ctrlDragging=true with ctrlDown=false should NOT yield grab/grabbing.
    expect(navCursor({ focused: true, ctrlDown: false, shiftDown: false, ctrlDragging: true })).toBe('crosshair');
    expect(navCursor({ focused: true, ctrlDown: false, shiftDown: true, ctrlDragging: true })).toBe('ew-resize');
  });

  // WS9 (Fix 1): the shift+wheel PAN is captured on HOVER (not just focus), so the
  // MODIFIER cursors must be discoverable while merely hovering with a modifier held —
  // even before the chart is clicked-to-focus. The plain (no-modifier) crosshair stays
  // FOCUS-ONLY so a bare hover doesn't make an unfocused chart look armed and plain
  // page-scroll past it is undisturbed.
  it('shows the Shift pan cursor on HOVER even when not focused (discoverable pan)', () => {
    expect(
      navCursor({ focused: false, hovering: true, ctrlDown: false, shiftDown: true, ctrlDragging: false }),
    ).toBe('ew-resize');
  });

  it('shows grab/grabbing on HOVER+Ctrl even when not focused', () => {
    expect(
      navCursor({ focused: false, hovering: true, ctrlDown: true, shiftDown: false, ctrlDragging: false }),
    ).toBe('grab');
    expect(
      navCursor({ focused: false, hovering: true, ctrlDown: true, shiftDown: false, ctrlDragging: true }),
    ).toBe('grabbing');
  });

  it('stays default on a bare hover with NO modifier (crosshair is focus-only)', () => {
    // Hovering an unfocused chart with no key held must NOT show crosshair — only a
    // held modifier arms a hover-cursor; otherwise the chart looks inert (and is, for
    // plain page-scroll).
    expect(
      navCursor({ focused: false, hovering: true, ctrlDown: false, shiftDown: false, ctrlDragging: false }),
    ).toBe('default');
  });
});
