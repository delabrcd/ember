// PURE zoom/refetch math for the IntervalHistory widget (issue #141). The history
// chart can be zoomed into a sub-span (Recharts Brush / drag-select) WITHOUT
// touching the global RangeControl. When the zoomed span is narrow, the widget
// refetches /api/interval for just that span so the user sees finer (less server-
// downsampled) detail instead of stretched decimated points.
//
// This module owns the two number/shaping decisions so they can be hand-calc
// unit-tested in isolation: (1) mapping a brushed [startMs, endMs] span to the
// route's YYYY-MM-DD day bounds, and (2) deciding whether a zoom warrants a
// finer-detail refetch. NO React / DOM / DB / fetch dependency.

const DAY_MS = 86_400_000;

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

// Map a brushed [startMs, endMs] span to inclusive UTC day bounds for /api/interval.
// The endpoints are ordered (a backwards drag still yields from ≤ to) and each is
// snapped to its UTC calendar day; the route then widens `to` to end-of-day so the
// full last day is captured. PURE.
export function zoomSpanToRange(startMs: number, endMs: number): ZoomRange {
  const lo = Math.min(startMs, endMs);
  const hi = Math.max(startMs, endMs);
  return { from: msToYmd(lo), to: msToYmd(hi) };
}

// Decide whether a zoom into [startMs, endMs] should trigger a finer-detail
// refetch given the span currently fetched ([fetchedFromMs, fetchedToMs]).
//
// We refetch only when BOTH hold:
//   • the zoomed span is at most `maxSpanDays` wide — narrow enough that an
//     un-downsampled (or far-less-downsampled) fetch is worthwhile and bounded;
//   • the zoomed span is at most `shrinkRatio` of the currently-fetched span —
//     it is meaningfully narrower than what we already have, so a refetch buys
//     real extra detail rather than re-fetching ~the same window.
//
// Both guards are necessary: the span guard caps payload/effort; the shrink guard
// avoids a pointless refetch when the user brushes ~the whole current window.
// PURE — returns just the decision (the impure widget does the actual fetch).
export function shouldRefetchZoom(
  startMs: number,
  endMs: number,
  fetchedFromMs: number,
  fetchedToMs: number,
  opts: { maxSpanDays: number; shrinkRatio: number },
): boolean {
  const zoomSpan = Math.abs(endMs - startMs);
  const fetchedSpan = Math.abs(fetchedToMs - fetchedFromMs);
  if (!(zoomSpan > 0) || !(fetchedSpan > 0)) return false;
  if (zoomSpan > opts.maxSpanDays * DAY_MS) return false;
  if (zoomSpan > fetchedSpan * opts.shrinkRatio) return false;
  return true;
}

// Clamp a brushed [start, end] index pair to a valid, ordered range inside a
// series of `len` points. Used to reconcile the CONTROLLED brush after the data
// underneath it changes (a finer-detail refetch swaps the rows in place, so the
// old indices may now be out of bounds). Guarantees 0 ≤ start ≤ end ≤ len-1 for
// any non-empty series; returns [0, 0] for an empty series (a degenerate brush
// the chart won't render anyway). PURE — index math only, no React/DOM.
export function clampBrushIndices(
  start: number,
  end: number,
  len: number,
): { startIndex: number; endIndex: number } {
  if (len <= 0) return { startIndex: 0, endIndex: 0 };
  const last = len - 1;
  // Normalize NaN/undefined-ish inputs to the endpoints, then clamp + order.
  let s = Number.isFinite(start) ? Math.round(start) : 0;
  let e = Number.isFinite(end) ? Math.round(end) : last;
  s = Math.min(Math.max(s, 0), last);
  e = Math.min(Math.max(e, 0), last);
  if (s > e) [s, e] = [e, s];
  return { startIndex: s, endIndex: e };
}
