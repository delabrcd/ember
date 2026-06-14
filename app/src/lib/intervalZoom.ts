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
