// PURE zoom math for the IntervalHistory widget (issue #141). The history chart
// is zoomed by DRAG-SELECT (a classic stock-chart gesture): the user drags a band
// across the chart and the widget refetches /api/interval for just that span so
// they see finer (less server-downsampled) detail. The zoom is local — it never
// touches the global RangeControl.
//
// This module owns the two number/shaping decisions so they can be hand-calc
// unit-tested in isolation: (1) mapping a dragged [startMs, endMs] span to the
// route's YYYY-MM-DD day bounds, and (2) deciding whether a drag-selection is
// deliberate enough to zoom (vs an accidental click). NO React / DOM / DB / fetch
// dependency.

// Convert an epoch-ms instant to a UTC YYYY-MM-DD day string. The /api/interval
// route parses `from`/`to` as UTC day bounds (Date.UTC(...,0,0,0) / 23:59:59.999),
// so we emit the UTC calendar day to stay consistent with how the route widens
// them. PURE.
export function msToYmd(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

// A zoom span expressed as the route's inclusive day bounds.
export type ZoomRange = { from: string; to: string };

// Map a dragged [startMs, endMs] span to inclusive UTC day bounds for /api/interval.
// The endpoints are ordered (a backwards drag still yields from ≤ to) and each is
// snapped to its UTC calendar day; the route then widens `to` to end-of-day so the
// full last day is captured. PURE.
export function zoomSpanToRange(startMs: number, endMs: number): ZoomRange {
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  return { from: msToYmd(lo), to: msToYmd(hi) };
}

// Decide whether a drag-selection between two data points is deliberate enough to
// zoom (vs an accidental click that registered a down+up on essentially the same
// spot). A real zoom requires BOTH:
//   • the two selected indices differ (a click lands both endpoints on one point);
//   • the selected ms span is at least `minSpanMs` wide — a tiny jitter-drag
//     across two adjacent points (e.g. a few minutes at 15m grain) should not zoom.
// With an explicit drag the user is asking to zoom to exactly what they drew, so
// there is NO upper-bound / shrink gating here — any deliberate selection zooms.
// PURE — returns just the decision (the impure widget does the actual fetch).
export function isZoomSelectionSignificant(
  startIndex: number,
  endIndex: number,
  startMs: number,
  endMs: number,
  minSpanMs: number,
): boolean {
  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return false;
  if (startIndex === endIndex) return false;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return false;
  return Math.abs(endMs - startMs) >= minSpanMs;
}

// The three distinguishable outcomes of a mouse-down→mouse-up gesture on the
// chart (issue #141):
//   • 'click'    — both endpoints landed on the same data point (no real drag).
//                  The widget stays SILENT: no zoom, no hint.
//   • 'too-small'— a DELIBERATE drag (the endpoints are distinct points) but the
//                  resulting span is below the hard zoom floor. The widget refuses
//                  the zoom and shows a brief "Max zoom reached" hint so the drag
//                  isn't a silent no-op.
//   • 'zoom'     — a productive drag (distinct points, span ≥ floor) → zoom.
export type ZoomSelectionKind = 'click' | 'too-small' | 'zoom';

// Classify a gesture into the three outcomes above. The distinction between a
// click and a too-small drag is the DATA INDEX, not the ms span: a click leaves
// both endpoints on one rendered point (startIndex === endIndex), whereas a
// deliberate drag moves the cursor to a *different* point even if the two points
// happen to be close together in time (e.g. two adjacent 15-min reads). That lets
// us stay silent on a click but give "you've hit the floor" feedback when the user
// genuinely tried to draw a band tighter than the minimum window.
//
// Non-finite endpoints are treated as a (silent) click — they can't describe a
// real selection. PURE — returns just the classification; the impure widget acts
// on it (zoom + refetch, transient hint, or nothing).
export function classifyZoomSelection(
  startIndex: number,
  endIndex: number,
  startMs: number,
  endMs: number,
  minSpanMs: number,
): ZoomSelectionKind {
  if (!Number.isFinite(startIndex) || !Number.isFinite(endIndex)) return 'click';
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 'click';
  if (startIndex === endIndex) return 'click';
  // Distinct points → a deliberate drag. Whether it zooms depends on the floor.
  return Math.abs(endMs - startMs) >= minSpanMs ? 'zoom' : 'too-small';
}

// ---- WS5: mouse-navigation window math --------------------------------------
// On TOP of the drag-select zoom above, WS5 adds focused mouse navigation: wheel
// to zoom on the cursor, Shift+wheel / Ctrl+drag to pan. The window MATH for those
// gestures lives here as PURE helpers so it can be hand-calc unit-tested in
// isolation — the widget owns only the impure shell (focus, native wheel listener,
// debounced refetch). Both helpers operate on epoch-ms instants and are clamped to
// the global `[boundsFromMs, boundsToMs]` window (the dashboard RangeControl span)
// and a `minSpanMs` floor; they never widen past the bounds nor below the floor.

// A window expressed as epoch-ms bounds (the in-memory representation the gestures
// manipulate before it's mapped to /api/interval day strings via zoomSpanToRange).
export type WindowMs = { fromMs: number; toMs: number };

// Zoom the window [fromMs, toMs] around a fixed center instant `centerMs`,
// contracting (factor < 1) or expanding (factor > 1) the span while keeping
// centerMs at the SAME FRACTIONAL position within the window — so the time under
// the cursor stays under the cursor as the user wheels. The result is clamped:
//   • the span never drops below `minSpanMs` (zoom-in floor: at the floor we keep
//     centerMs's fractional position and just stop shrinking);
//   • neither edge ever leaves [boundsFromMs, boundsToMs]; if the new (wider) span
//     would exceed the full bounds, it collapses to exactly the bounds.
// When an edge clamps, the OTHER edge is NOT pushed past its bound — the span is
// pinned to the bound rather than sliding (a zoom-out that hits the left wall stops
// growing leftward but keeps growing rightward until it too hits the wall, at which
// point the whole window equals the bounds). PURE — no React/DOM.
//
// `factor` is the multiplier applied to the CURRENT span (e.g. 0.85 = zoom in one
// ~15% notch, 1/0.85 ≈ 1.176 = zoom out). The caller derives it from the wheel
// delta sign; this helper is direction-agnostic.
export function zoomWindowAroundCenter(
  fromMs: number,
  toMs: number,
  centerMs: number,
  factor: number,
  boundsFromMs: number,
  boundsToMs: number,
  minSpanMs: number,
): WindowMs {
  // Guard: malformed inputs → return the (ordered) input window unchanged.
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    !Number.isFinite(centerMs) ||
    !Number.isFinite(factor) ||
    factor <= 0 ||
    !Number.isFinite(boundsFromMs) ||
    !Number.isFinite(boundsToMs)
  ) {
    return { fromMs: Math.min(fromMs, toMs), toMs: Math.max(fromMs, toMs) };
  }
  const lo = Math.min(fromMs, toMs);
  const hi = Math.max(fromMs, toMs);
  const bLo = Math.min(boundsFromMs, boundsToMs);
  const bHi = Math.max(boundsFromMs, boundsToMs);
  const boundSpan = bHi - bLo;

  const curSpan = hi - lo;
  // The new span: scaled, floored at minSpanMs, and capped at the full bounds span
  // (can't be wider than the global window).
  const floor = Math.min(minSpanMs, boundSpan); // a tiny global window can't demand a bigger floor
  let newSpan = curSpan * factor;
  if (newSpan < floor) newSpan = floor;
  if (newSpan > boundSpan) newSpan = boundSpan;

  // Keep centerMs at the same fractional position `frac` within the window. Clamp
  // the center into the window first so a center outside [lo,hi] (cursor off the
  // plot) degrades to the nearest edge rather than throwing the math off.
  const clampedCenter = Math.min(Math.max(centerMs, lo), hi);
  const frac = curSpan > 0 ? (clampedCenter - lo) / curSpan : 0.5;

  // newLo so that clampedCenter sits at the same fraction of the new span.
  let newLo = clampedCenter - frac * newSpan;
  let newHi = newLo + newSpan;

  // Clamp into bounds WITHOUT changing the span (slide the window back inside).
  if (newLo < bLo) {
    newLo = bLo;
    newHi = bLo + newSpan;
  }
  if (newHi > bHi) {
    newHi = bHi;
    newLo = bHi - newSpan;
  }
  // After sliding, the low edge may still dip below bLo only if newSpan === boundSpan;
  // pin it exactly to the bounds in that case.
  if (newLo < bLo) newLo = bLo;
  return { fromMs: newLo, toMs: newHi };
}

// Shift (pan) the window [fromMs, toMs] by `deltaMs` (positive = later/right,
// negative = earlier/left) WITHOUT changing its span, clamped so it never leaves
// [boundsFromMs, boundsToMs]. At an edge the SHIFT is reduced (not the span): a pan
// that would push the window past the wall stops at the wall. If the window already
// equals/exceeds the bounds it can't pan at all (returns it pinned to the bounds).
// PURE — no React/DOM.
export function panWindow(
  fromMs: number,
  toMs: number,
  deltaMs: number,
  boundsFromMs: number,
  boundsToMs: number,
): WindowMs {
  if (
    !Number.isFinite(fromMs) ||
    !Number.isFinite(toMs) ||
    !Number.isFinite(deltaMs) ||
    !Number.isFinite(boundsFromMs) ||
    !Number.isFinite(boundsToMs)
  ) {
    return { fromMs: Math.min(fromMs, toMs), toMs: Math.max(fromMs, toMs) };
  }
  const lo = Math.min(fromMs, toMs);
  const hi = Math.max(fromMs, toMs);
  const bLo = Math.min(boundsFromMs, boundsToMs);
  const bHi = Math.max(boundsFromMs, boundsToMs);
  const span = hi - lo;

  // Window already spans (or exceeds) the bounds → pin to the bounds, no pan room.
  if (span >= bHi - bLo) return { fromMs: bLo, toMs: bLo + (bHi - bLo) };

  // Reduce the shift at the walls: the max we can move right is (bHi - hi), the max
  // left is (bLo - lo) (a negative number). Clamp delta into that travel range.
  const maxRight = bHi - hi; // ≥ 0
  const maxLeft = bLo - lo; // ≤ 0
  let d = deltaMs;
  if (d > maxRight) d = maxRight;
  if (d < maxLeft) d = maxLeft;
  return { fromMs: lo + d, toMs: hi + d };
}

// ---- WS7: live view-domain resolver -----------------------------------------
// WS7 makes pan/zoom track the gesture LIVE: the chart X axis is a NUMERIC TIME
// axis whose `domain` is a view window in epoch-ms, DECOUPLED from the loaded data.
// During a gesture we move the view window every wheel-notch / drag-move so the
// *already-loaded* points re-render under the new domain (the line visibly slides /
// scales), then a DEBOUNCED refetch swaps fresh rows in for the settled window.
//
// `viewDomainFor` is the tiny PURE piece of that: given the current live window
// (the zoom span when zoomed, else null = follow the global bounds) and the global
// `[boundsFromMs, boundsToMs]`, it returns the `[fromMs, toMs]` the numeric XAxis
// `domain` should use. Kept pure so the (impure) widget never buries the choice in
// JSX. Rules:
//   • a valid zoom window (finite, fromMs < toMs) → use it verbatim (live edits to
//     the zoom window are already clamped by panWindow/zoomWindowAroundCenter);
//   • otherwise → fall back to the global bounds (ordered);
//   • if the bounds themselves are non-finite (a non-dashboard caller with no range)
//     → return null so the caller lets Recharts auto-fit the domain to the data.
// PURE — no React/DOM.
export function viewDomainFor(
  zoomFromMs: number | null | undefined,
  zoomToMs: number | null | undefined,
  boundsFromMs: number,
  boundsToMs: number,
): WindowMs | null {
  // Prefer an explicit live zoom window when it's a real, ordered span.
  if (
    zoomFromMs != null &&
    zoomToMs != null &&
    Number.isFinite(zoomFromMs) &&
    Number.isFinite(zoomToMs) &&
    zoomFromMs < zoomToMs
  ) {
    return { fromMs: zoomFromMs, toMs: zoomToMs };
  }
  // Else fall back to the global bounds, if they're usable.
  if (Number.isFinite(boundsFromMs) && Number.isFinite(boundsToMs)) {
    const lo = Math.min(boundsFromMs, boundsToMs);
    const hi = Math.max(boundsFromMs, boundsToMs);
    if (lo < hi) return { fromMs: lo, toMs: hi };
  }
  // No usable window → let Recharts auto-fit the numeric domain to the data.
  return null;
}

// ---- WS6: modifier → cursor resolver ----------------------------------------
// WS6 gives the focused chart MODAL cursor feedback so the held modifier signals
// which navigation gesture is armed. The mapping is a tiny pure function so it can
// be hand-tested in isolation (don't bury this decision table in JSX): given the
// current focus + modifier state it returns the exact CSS `cursor` keyword to apply
// to the chart's `style.cursor`. PURE — no React/DOM.
//
// The precedence is deliberate and matches the gesture-handler precedence in the
// widget (the Ctrl branch is checked FIRST in onChartMouseDown / the wheel handler):
//   • NOT focused, no modifier on hover → 'default'  (gestures inert; normal page)
//   • Ctrl held + actively dragging → 'grabbing'  (the viewport is being grabbed)
//   • Ctrl held (not yet dragging)  → 'grab'      ("you can grab to move the viewport")
//   • Shift held                    → 'ew-resize' (shift+wheel pans left/right)
//   • focused, no modifier          → 'crosshair' (plain drag still zoom-SELECTs)
// Ctrl wins over Shift if (improbably) both are held, mirroring the handlers where
// the Ctrl+drag pan is checked before anything else. `ctrlDragging` only matters
// while Ctrl is down, so we read it under the Ctrl branch.
//
// WS9 (Fix 1) — HOVER-DISCOVERABILITY: the shift+wheel pan now engages on HOVER, not
// only when the chart is clicked-to-focus (the operator naturally shift+scrolls on
// hover). So the MODIFIER cursors (ew-resize / grab / grabbing) must also show while
// merely HOVERING with a modifier held, even before focus — otherwise the gesture is
// invisible until you click. The resolver gates the *modifier* cursors on
// `focused || hovering`; the plain-no-modifier crosshair stays FOCUS-ONLY (a bare
// hover over an unfocused chart leaves the normal 'default' cursor so the chart
// doesn't look armed when it isn't, and plain page-scroll past it is undisturbed).
// `hovering` is optional and defaults false → unchanged for any caller that omits it.
export type NavCursorState = {
  focused: boolean;
  ctrlDown: boolean;
  shiftDown: boolean;
  ctrlDragging: boolean;
  // WS9: true while the cursor is over the chart body. Lets a held modifier resolve
  // its cursor on hover (pan is hover-capturable now), even without focus. Optional
  // for back-compat with the WS6 callers/tests that only pass the four flags.
  hovering?: boolean;
};

export type NavCursor = 'default' | 'crosshair' | 'grab' | 'grabbing' | 'ew-resize';

export function navCursor(state: NavCursorState): NavCursor {
  // The modifier cursors are armed when the gesture is reachable — i.e. focused OR
  // merely hovering (WS9: shift+wheel pans on hover; ctrl+drag still needs the click,
  // but showing 'grab' on hover with Ctrl is a harmless, consistent hint).
  const armed = state.focused || !!state.hovering;
  if (armed && state.ctrlDown) return state.ctrlDragging ? 'grabbing' : 'grab';
  if (armed && state.shiftDown) return 'ew-resize';
  // No modifier: the plain drag-to-zoom crosshair is FOCUS-ONLY (a bare hover over an
  // unfocused chart stays 'default' so it doesn't look armed and page-scroll is free).
  if (state.focused) return 'crosshair';
  return 'default';
}

// Decide whether the /api/interval downsampler actually reduced a result set —
// i.e. whether FINER detail exists than what was returned (issue #141, the
// "finest detail / max zoom" badge). It mirrors downsampleByTime's own gate
// (`rows.length <= maxPoints` ⇒ returned as-is): the set is downsampled exactly
// when there were MORE raw rows than the cap. When false, the chart is already at
// its native resolution and zooming further reveals nothing new. PURE.
export function wasDownsampled(rawRowCount: number, maxPoints: number): boolean {
  if (!Number.isFinite(rawRowCount) || !Number.isFinite(maxPoints)) return false;
  if (maxPoints <= 0) return false; // downsampler is disabled → never reduces
  return rawRowCount > maxPoints;
}
