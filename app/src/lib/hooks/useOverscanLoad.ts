'use client';

// The IntervalHistory overscan-reconcile trio (issue #156 extract; WS8). This is the
// impure shell that decides WHAT WINDOW gets fetched, decoupled from the live pan/zoom
// view. All the WINDOW MATH is the PURE overscan helpers (lib/intervalOverscan.ts) +
// msToYmd (lib/intervalZoom.ts); this hook owns only the React state + the debounce.
//
// THE MODEL (WS8): gestures move the visible VIEW immediately (live, no refetch); a
// DEBOUNCED reconcile decides — via the pure overscan helpers — whether the view has
// panned near a loaded edge or zoomed to a new bucket, and only THEN sets a new `load`
// (a window WIDER than the view, at the view's grain). A pan that stays inside the
// loaded superset sets nothing, so there's no refetch in the loop.
//
// The hook exposes:
//   • `load` — the LOADED-SUPERSET descriptor that drives the fetch (`null` ⇒ follow
//     the global window with no explicit bucket: the initial/reset state).
//   • `scheduleReconcile(viewWin, immediate?)` — the debounced (or synchronous, for
//     discrete gestures) reconcile the gesture handlers call with the NEXT view.
//   • `resetLoad()` — clear `load` AND the pending debounce timer synchronously (the
//     widget's context-change effect calls this when fuel/range/account changes).
//
// SINGLE-FLIGHT: the fetch layer dedupes one in-flight request per key (swrFetch), and
// we only ever set ONE pending `load` (the debounce coalesces a flurry of gesture ticks
// into one reconcile), so rapid panning can't spawn a swarm of fetches.
//
// Impure browser shell under lib/hooks (the type-checked lib ESLint applies); the
// hermetic vitest suite never imports it.

import { useCallback, useEffect, useRef, useState } from 'react';
import { msToYmd } from '@/lib/intervalZoom';
import {
  overscanWindowFor,
  isViewNearLoadedEdge,
  viewSpanBucketSecs,
  overscanBucketChanged,
  type OverscanWindow,
} from '@/lib/intervalOverscan';
import { MAX_POINTS } from '@/lib/viz/downsampleInterval';

// Debounce for the gesture-driven reconcile: coalesce a flurry of wheel/pan ticks into
// ONE reconcile after the gestures settle (so at most one extend-load per settled
// gesture). The route is ~15–40ms so this stays snappy.
const NAV_REFETCH_DEBOUNCE_MS = 150;

// WS8 OVERSCAN: the LOADED SUPERSET descriptor — what /api/interval was actually
// fetched for, DECOUPLED from the visible view. It's a window WIDER than the view
// (`overscanWindowFor`) aggregated at the VIEW's grain (`bucketSecs`), so panning
// within it stays over real data with no refetch (no blank edge, no resize). The
// view-domain is what's SHOWN; this is what's LOADED. `bucketSecs` is sent as the
// `?bucket=` param so the wider window keeps the view's resolution; we recompute it
// from the view span and reload when a ZOOM changes the bucket.
export type LoadWindow = { from: string; to: string; bucketSecs: number };

// The bounds + validity the reconcile clamps against (the GLOBAL RangeControl window
// in epoch-ms). `boundsValid` is false for a non-dashboard caller with no bounds.
type Bounds = { boundsFromMs: number; boundsToMs: number; boundsValid: boolean };

export function useOverscanLoad({ boundsFromMs, boundsToMs, boundsValid }: Bounds): {
  load: LoadWindow | null;
  scheduleReconcile: (viewWin: OverscanWindow | null, immediate?: boolean) => void;
  resetLoad: () => void;
} {
  const [load, setLoad] = useState<LoadWindow | null>(null);

  // A FRESH mirror of `load` so the debounced reconcile reads the current superset
  // without re-arming on every `load` change (the reconcile runs after a gesture, by
  // which time React may not have committed the latest `load`). Kept in sync below.
  const loadRef = useRef<LoadWindow | null>(null);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  // The debounce timer handle for the gesture reconcile.
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Build the LOADED-SUPERSET descriptor for a given visible VIEW window: widen the
  // view to the overscan superset (real data on both sides) and aggregate it at the
  // VIEW's grain (grain coherence — the wider span must NOT pick a coarser bucket).
  // Emits the route's inclusive UTC day bounds (the route widens `to` to end-of-day).
  // PURE-derived (delegates to the pure overscan helpers); no side effects.
  const loadWindowForView = useCallback(
    (viewWin: OverscanWindow): LoadWindow => {
      const superset = overscanWindowFor(viewWin, boundsFromMs, boundsToMs);
      const bucketSecs = viewSpanBucketSecs(viewWin, MAX_POINTS);
      return { from: msToYmd(superset.fromMs), to: msToYmd(superset.toMs), bucketSecs };
    },
    [boundsFromMs, boundsToMs],
  );

  // Decide whether to (re)load the overscan superset for the CURRENT view window, and
  // if so set `load` (which drives the fetch). DECOUPLED from the live pan/zoom: a pan
  // that stays inside the loaded superset at the same grain is a NO-OP here (no
  // refetch → no resize). We (re)load only when:
  //   • nothing is loaded yet (first paint after a gesture), OR
  //   • a ZOOM changed the view-span bucket (overscanBucketChanged) → reload at the
  //     new grain, re-centered on the view, OR
  //   • a PAN brought the view near a loaded edge (isViewNearLoadedEdge) → top the
  //     overscan back up by re-centering on the view (same grain).
  // In every reload case the new superset is RE-CENTERED on the current view, so the
  // visible slice is the SAME data — the swap is invisible (no domain move, and WS8's
  // <Line> has no animation, so it never resizes). SINGLE-FLIGHT: the fetch effect
  // dedupes one in-flight request per key (swrFetch), and we only ever set ONE pending
  // `load` (the debounce coalesces a flurry of gesture ticks into one reconcile), so
  // rapid panning can't spawn a swarm of fetches. `null` view (reset / no bounds) →
  // clear `load` (follow the global window).
  const reconcileLoad = useCallback(
    (viewWin: OverscanWindow | null) => {
      if (!viewWin || !boundsValid) {
        setLoad(null);
        return;
      }
      const cur = loadRef.current;
      const bucketChanged = overscanBucketChanged(viewWin, cur?.bucketSecs ?? null, MAX_POINTS);
      // The currently-loaded superset's window in ms (for the edge-proximity check).
      const loadedWin: OverscanWindow | null = cur
        ? {
            fromMs: new Date(cur.from).getTime(),
            // The route widens `to` to end-of-day; mirror that so the edge check uses
            // the real loaded extent (not the start of the last day).
            toMs: new Date(cur.to).getTime() + (24 * 60 * 60_000 - 1),
          }
        : null;
      const nearEdge =
        loadedWin != null &&
        isViewNearLoadedEdge(viewWin, loadedWin, boundsFromMs, boundsToMs);
      if (cur && !bucketChanged && !nearEdge) return; // view still inside the superset → no refetch
      setLoad(loadWindowForView(viewWin));
    },
    [boundsValid, boundsFromMs, boundsToMs, loadWindowForView],
  );

  // Debounced wrapper: a flurry of wheel/pan ticks coalesces into ONE reconcile after
  // NAV_REFETCH_DEBOUNCE_MS (so at most one extend-load per settled gesture).
  // `immediate` runs it synchronously for discrete gestures (drag-select commit /
  // reset) where there's no flurry to coalesce. The caller passes the NEXT view window
  // explicitly (the one the gesture just produced) so the reconcile doesn't depend on
  // React having committed `zoom` yet.
  const scheduleReconcile = useCallback(
    (viewWin: OverscanWindow | null, immediate = false) => {
      if (navTimerRef.current) {
        clearTimeout(navTimerRef.current);
        navTimerRef.current = null;
      }
      if (immediate) {
        reconcileLoad(viewWin);
        return;
      }
      navTimerRef.current = setTimeout(() => {
        navTimerRef.current = null;
        reconcileLoad(viewWin);
      }, NAV_REFETCH_DEBOUNCE_MS);
    },
    [reconcileLoad],
  );

  // Clear `load` AND any pending debounce timer synchronously. The widget calls this
  // from its context-change effect (fuel/range/account change) so the next reconcile
  // loads a fresh superset and a queued reconcile from the old context can't land.
  const resetLoad = useCallback(() => {
    setLoad(null);
    if (navTimerRef.current) {
      clearTimeout(navTimerRef.current);
      navTimerRef.current = null;
    }
  }, []);

  // Clean up the debounce timer on unmount.
  useEffect(
    () => () => {
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
    },
    [],
  );

  return { load, scheduleReconcile, resetLoad };
}
