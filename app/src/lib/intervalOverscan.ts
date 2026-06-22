// PURE overscan-window math for the IntervalHistory widget (WS8). WS7 made pan/zoom
// MOVE the view live, but the rendered DATA was only the rows for the (old) settled
// window — so a horizontal PAN slid the view-domain over data that wasn't loaded yet
// (a blank LEADING edge), and when the debounced refetch landed the line resized /
// morphed into place. That "resize once the scroll stops" is the jank WS8 removes.
//
// THE MODEL — decouple WHAT'S LOADED from WHAT'S SHOWN:
//   • `view`   = the VISIBLE window (epoch-ms), already derived from the live `zoom`
//                (WS7). Every gesture moves it instantly.
//   • `loaded` = a WIDER SUPERSET actually fetched from /api/interval: a window
//                `[view.from - MARGIN, view.to + MARGIN]` plus the rows + the bucket
//                they were aggregated at. The view always sits INSIDE the loaded
//                window with real data on both sides, so panning up to a full
//                view-width in either direction stays over REAL data — no blank edge,
//                and (crucially) no refetch in the pan loop, so no resize/morph.
//
// MARGIN = OVERSCAN_MARGIN_FRACTION × the VIEW span on EACH side (fraction 1 → the
// loaded window is ~3× the view: one view-width of overscan left, one right). When
// the view approaches a loaded edge (within EXTEND_TRIGGER_FRACTION of MARGIN of
// `loaded.from`/`loaded.to`) the widget kicks a BACKGROUND extend-load: refetch a
// fresh superset re-centered on the current view and swap the rows in WITHOUT moving
// the view domain (the visible slice is identical data, so the swap is invisible).
//
// GRAIN COHERENCE (the subtle part): the superset must be aggregated at the VIEW's
// grain, NOT the wider overscan span's grain. If the route ran chooseBucket on the
// overscan [from,to] it would pick a COARSER bucket (the span is ~3× wider) and the
// visible slice would render too coarse. So the caller computes `bucketSecs` from the
// VIEW span (the same chooseBucket the server would pick for the view) and fetches the
// overscan range AT THAT BUCKET (the `?bucket=` route param). `overscanBucketChanged`
// tells the widget when a ZOOM changed the view span enough to change that bucket — a
// signal to drop the cached superset and load a fresh one at the new grain.
//
// All of this is number math, kept PURE here (no React/DOM/fetch) so it can be
// hand-calc unit-tested in isolation — the widget owns only the impure shell (state,
// the single-flight fetch guard, swapping rows in).

import { chooseBucket } from './viz/chooseBucket';

// A window expressed as epoch-ms bounds (mirrors WindowMs in intervalZoom, kept local
// to avoid a cross-import cycle; structurally identical).
export type OverscanWindow = { fromMs: number; toMs: number };

// How much overscan to load on EACH side of the view, as a fraction of the view span.
// 1 → MARGIN equals one full view-width per side, so the loaded window is ~3× the
// view. That lets the user pan a FULL view-width in either direction before they can
// reach a loaded edge — generous enough that a normal drag never out-runs the data,
// cheap enough that the superset is only ~3× the points the view needs.
export const OVERSCAN_MARGIN_FRACTION = 1;

// Trigger a background extend-load when the view edge gets within this fraction of
// MARGIN of a loaded edge — i.e. when ~75% of one side's overscan has been "eaten"
// by panning. Re-centering then tops the overscan back up to a full MARGIN on both
// sides before the user can reach the actual data edge. 0.25 leaves a comfortable
// safety buffer (a quarter-MARGIN ≈ a quarter view-width) for the fetch to land.
export const EXTEND_TRIGGER_FRACTION = 0.25;

// Compute the superset window to LOAD for a given visible `view`: widen it by
// MARGIN = OVERSCAN_MARGIN_FRACTION × (view span) on each side, then CLAMP to the
// global `[boundsFromMs, boundsToMs]` so we never request data outside the dashboard
// range (there's none to load, and the route would just widen `to` to end-of-day).
//
// Clamping at the bounds is fine for the no-blank-edge guarantee: when the view butts
// against a global edge there's simply no data beyond it to show, so a blank past the
// wall is correct (it's the end of history), not a loading artifact.
//
// Degenerate/malformed inputs (non-finite, inverted) collapse to the ordered view
// itself so a caller never fetches a nonsense range. PURE.
export function overscanWindowFor(
  view: OverscanWindow,
  boundsFromMs: number,
  boundsToMs: number,
  marginFraction: number = OVERSCAN_MARGIN_FRACTION,
): OverscanWindow {
  const vLo = Math.min(view.fromMs, view.toMs);
  const vHi = Math.max(view.fromMs, view.toMs);
  if (!Number.isFinite(vLo) || !Number.isFinite(vHi)) {
    return { fromMs: vLo, toMs: vHi };
  }
  const span = vHi - vLo;
  const margin = span > 0 && Number.isFinite(marginFraction) ? span * marginFraction : 0;
  let lo = vLo - margin;
  let hi = vHi + margin;
  // Clamp to the global bounds when they're usable (a non-dashboard caller may pass
  // non-finite bounds → leave the widened window unclamped, the route handles it).
  if (Number.isFinite(boundsFromMs) && Number.isFinite(boundsToMs)) {
    const bLo = Math.min(boundsFromMs, boundsToMs);
    const bHi = Math.max(boundsFromMs, boundsToMs);
    if (lo < bLo) lo = bLo;
    if (hi > bHi) hi = bHi;
  }
  return { fromMs: lo, toMs: hi };
}

// Decide whether the visible `view` has panned close enough to a `loaded` edge that a
// background extend-load should fire. True when EITHER:
//   • view.from is within (EXTEND_TRIGGER_FRACTION × MARGIN) of loaded.from AND
//     loaded.from is NOT already pinned to the left global bound (nothing more to
//     load past the wall), OR
//   • the symmetric condition on the right edge.
// MARGIN is recomputed from the CURRENT view span (the same definition
// overscanWindowFor uses) so the trigger tracks the view as it zooms. A zero/negative
// view span, or a loaded window already covering the full bounds, → false (no useful
// extend). PURE — returns just the predicate; the widget guards the actual fetch
// (single-flight) so a true here can't spawn a flurry of loads.
export function isViewNearLoadedEdge(
  view: OverscanWindow,
  loaded: OverscanWindow,
  boundsFromMs: number,
  boundsToMs: number,
  marginFraction: number = OVERSCAN_MARGIN_FRACTION,
  triggerFraction: number = EXTEND_TRIGGER_FRACTION,
): boolean {
  const vLo = Math.min(view.fromMs, view.toMs);
  const vHi = Math.max(view.fromMs, view.toMs);
  const lLo = Math.min(loaded.fromMs, loaded.toMs);
  const lHi = Math.max(loaded.fromMs, loaded.toMs);
  if (
    !Number.isFinite(vLo) ||
    !Number.isFinite(vHi) ||
    !Number.isFinite(lLo) ||
    !Number.isFinite(lHi)
  ) {
    return false;
  }
  const span = vHi - vLo;
  if (span <= 0) return false;
  const margin = span * marginFraction;
  if (margin <= 0) return false;
  const threshold = margin * triggerFraction;

  // The global bounds (used to skip an extend that would just re-fetch the same edge
  // because there's no data beyond the wall to gain).
  const haveBounds = Number.isFinite(boundsFromMs) && Number.isFinite(boundsToMs);
  const bLo = haveBounds ? Math.min(boundsFromMs, boundsToMs) : -Infinity;
  const bHi = haveBounds ? Math.max(boundsFromMs, boundsToMs) : Infinity;

  // Left edge: view.from approaching loaded.from, and loaded.from isn't already at the
  // wall (1ms slop absorbs clamp rounding).
  const leftRoom = lLo > bLo + 1;
  const nearLeft = leftRoom && vLo - lLo <= threshold;

  // Right edge: loaded.to approaching from above, and loaded.to isn't already at the
  // wall.
  const rightRoom = lHi < bHi - 1;
  const nearRight = rightRoom && lHi - vHi <= threshold;

  return nearLeft || nearRight;
}

// The bucket (seconds) to aggregate the OVERSCAN superset at — derived from the VIEW
// span, NOT the overscan span (grain coherence; see the module header). Thin wrapper
// over chooseBucket so the widget and any test compute it identically. `maxPoints` is
// the same ≤MAX_POINTS budget the route uses for the view. PURE.
export function viewSpanBucketSecs(view: OverscanWindow, maxPoints: number): number {
  const span = Math.abs(view.toMs - view.fromMs);
  return chooseBucket(span, maxPoints);
}

// Whether a NEW view span maps to a DIFFERENT bucket than the loaded superset was
// fetched at — i.e. a ZOOM changed the grain. When true the widget must DISCARD the
// cached superset and load a fresh one at the new bucket (a same-bucket pan can keep
// reusing/extending the existing superset). `loadedBucket` is null/undefined when no
// superset is loaded yet (→ always "changed", forcing the first load). PURE.
export function overscanBucketChanged(
  view: OverscanWindow,
  loadedBucket: number | null | undefined,
  maxPoints: number,
): boolean {
  if (loadedBucket == null) return true;
  return viewSpanBucketSecs(view, maxPoints) !== loadedBucket;
}
