'use client';

// The interval HISTORY widget (issue #121 part 2; WS2 UX rework): a self-contained
// dashboard tile showing the historical smart-meter reads over time. Unlike the
// load-shape widget (which shows an AVERAGE DAY profile), this widget plots the
// actual timeline so the user can see usage trends, daily patterns, and gaps.
//
// SELF-FETCHING (deliberately contained): like IntervalLoadShape, this widget owns
// its own data. On mount (and whenever the fuel, the selected account, or the
// window changes) it fetches /api/interval and draws the result with Recharts. It
// does NOT touch the ChartSpec/ConfigurableChart seam.
//
// SERVER-PICKED RESOLUTION (WS1 + WS2). The widget no longer chooses a 1h/15m
// grain. WS1 moved ALL resolution logic to the server: /api/interval picks the
// bucket width from the requested [from, to] window (chooseBucket), SUMS energy
// into those buckets in SQL (energy is additive), and — when the window is small
// enough to fall in the 15-min band — returns a uniform 15-min grid. The response
// carries `grain` (the chosen bucket in SECONDS), `fifteenMinFrom` (the earliest
// 15-min timestamp for this fuel/account, or null), and `downsampled` (whether
// finer detail exists than what's returned). So WS2's client:
//   • renders the server `rows` DIRECTLY — no client reconcile, filter, or
//     downsample; a thin map (toHistoryPoints) to {label, ts, value} is all.
//   • has ONE energy line per fuel (the Resolution 1h/15m toggle is GONE).
//   • labels the resolution from the numeric `grain` (formatGrain).
//
// CONTROLS:
//   • Fuel: Electric | Gas  (the only toggle now)
//
// RANGE (issue #36): the widget follows the GLOBAL RangeControl, receiving the
// resolved `from`/`to` ISO day bounds as props and fetching
// /api/interval?fuel=…&from=…&to=… (it no longer sends `grain`). The server bounds
// the series to ≤ MAX_POINTS regardless of how wide the range is.
//
// ZOOM (issue #141): on TOP of the global range, the user narrows into a sub-span
// LOCALLY by DRAG-SELECTING a band across the chart, without mutating the global
// RangeControl. We listen to the Recharts LineChart mouse handlers: onMouseDown
// records the start x, onMouseMove (while dragging) updates the current x, onMouseUp
// commits. The in-progress band is a <ReferenceArea>. On commit the two selected x
// positions map to their points' ts and become the zoom window; we refetch
// /api/interval for just that span — a narrower window → the server picks a FINER
// grain (e.g. the 15-min grid), so zooming literally trades range for resolution.
//
// WHY DRAG-SELECT, NOT A BRUSH: a Recharts <Brush> handle sub-selects the loaded
// data; when a narrow drag refetched finer data the handle had nothing left to
// sub-select and reset to full width ("snap back to the start"). A drag-select has
// no persistent handle, so nothing can snap — each drag commits a new zoom + refetch.
//
// "END OF 15-MIN DATA" MARKER (WS2): when the response's `fifteenMinFrom` falls
// inside the visible window AND the fuel is Electric (there is no 15-min GAS data),
// we draw a <ReferenceLine> at that x. Left of it the line is coarser (hourly, or
// the grid's quarter-steps); the marker tells the user "this is where true 15-min
// detail begins" so the flatter left side reads as lower resolution, not as a data
// problem. Out-of-window or null fifteenMinFrom, or Gas → no marker.
//
// STALE-WHILE-REVALIDATE — NEVER COLD-BLANK (WS2): historically a base reload
// (fuel/range/account change) blanked the whole chart to the pulse skeleton. Now,
// once there is ANY data on screen, a reload KEEPS the prior chart visible and
// overlays a subtle "updating" shimmer while the new response loads, then swaps the
// rows in place. Only the very first load (nothing cached, nothing on screen) shows
// the skeleton. A small client SWR cache (lib/intervalCache.ts) backs this: the
// widget paints the last-seen series for the new key INSTANTLY from cache (if warm)
// while revalidating, so a fuel-toggle / range-change feels instant. The `alive`
// stale-response guard still prevents an out-of-order response from overwriting a
// newer one.
//
// GAPS: connectNulls={false} is load-bearing — missing intervals (the API omits
// them) render as line BREAKS, NEVER as fabricated zeros. The server returns gaps
// as absent rows; toHistoryPoints keeps them absent.
//
// MOUSE NAVIGATION (WS5): on TOP of the drag-select zoom, the chart supports
// FOCUSED mouse navigation — gestures that engage ONLY while the chart is focused:
//   • Click the chart body → focus it (a subtle amber focus ring appears). Click
//     OUTSIDE, or press Esc, releases focus. The wheel/pan gestures below are live
//     ONLY while focused.
//   • Wheel up/down → zoom IN/OUT centered on the time under the cursor (the window
//     contracts/expands around the cursor's data point; ~12% per notch). The wheel
//     is captured (page-scroll prevented) ONLY while focused, so scrolling past an
//     UNfocused chart never gets trapped.
//   • Shift+wheel → pan the window left/right (~12% of the span per notch).
//   • Ctrl+drag → grab-and-pan the viewport horizontally (the window moves OPPOSITE
//     the drag, like grabbing the plot). A PLAIN drag (no Ctrl) stays the existing
//     zoom-SELECT band — WS5 does not touch that path.
// All the WINDOW MATH is the PURE zoomWindowAroundCenter / panWindow in
// lib/intervalZoom.ts (hand-calc unit-tested); this component is only the impure
// shell: focus tracking, the native non-passive wheel listener (React onWheel is
// passive and can't preventDefault), Ctrl/hover tracking via refs, and a DEBOUNCED
// refetch so a flurry of wheel ticks coalesces into ONE /api/interval request.
//
// The gesture window is expressed in epoch-MS and clamped to the global
// [from, to] window (never zoom out past it, never pan outside it, never below the
// 1-hour MIN_ZOOM_SPAN_MS floor). When a zoom-out reaches the full global window we
// CLEAR the local zoom (equivalent to Reset; the "Reset zoom" affordance hides).
// The display window (`zoom`) updates IMMEDIATELY for responsiveness; the actual
// fetch window is governed by WS8's overscan reconcile (a debounced `load` superset)
// so rapid ticks don't spam the route — see the WS8 note below.
//
// LIVE PAN/ZOOM + NUMERIC TIME AXIS (WS7): WS5/WS6 updated the *window* live but the
// LINE only re-rendered after the debounced refetch — so the graph didn't track the
// gesture; it jumped when the new data landed. WS7 makes the motion CONTINUOUS by
// DECOUPLING the rendered DATA from the rendered VIEW:
//   • The X axis is now a NUMERIC TIME axis — `dataKey="ts"`, `type="number"`,
//     `scale="time"`, with an explicit `domain={[view.fromMs, view.toMs]}` and
//     `allowDataOverflow` so the line CLIPS to the domain. (It was a CATEGORICAL
//     `dataKey="label"` axis, which can only show the loaded points edge-to-edge and
//     so can't slide/scale under a moving window.) Tick labels reuse the SAME
//     `formatHistoryLabel` the categorical `label` used, so they read identically.
//   • A LIVE VIEW WINDOW (`view = {fromMs,toMs}`) is held in state, driving that
//     `domain`. Every wheel-notch / drag-move updates `view` IMMEDIATELY, so the
//     currently-loaded points re-render under the new domain → the graph visibly
//     slides (pan) / scales (zoom) in real time, with NO refetch in the loop.
//   • The /api/interval refetch for the SETTLED window is still DEBOUNCED
//     (NAV_REFETCH_DEBOUNCE_MS); when the new (finer) rows arrive we swap them in and
//     RECONCILE `view` to the fetched window. A brief blank at a leading edge before
//     that ~15–40ms refetch lands is acceptable.
// The window MATH is unchanged — the same PURE panWindow / zoomWindowAroundCenter
// produce the next window; WS7 just also pushes that window straight into `view`
// (the numeric domain) instead of only into the debounced fetch. `viewDomainFor`
// (pure, in lib/intervalZoom.ts) resolves the domain from the zoom-or-bounds.
//
// WS7 also fixes a SCROLL LEAK: shift+wheel used to pan the graph AND scroll the
// page (an early `return` skipped preventDefault for the no-data path, and the
// `focused` closure could be stale right after focusing). The native wheel listener
// now reads focus from a fresh REF and ALWAYS preventDefault()s while focused (zoom
// AND pan paths), and reads BOTH deltaY and deltaX (shift+wheel emits a horizontal
// delta on many setups). Net: while focused the page never scrolls from the wheel;
// while unfocused the wheel is untouched.
//
// OVERSCAN PRELOAD + NO RESIZE ANIMATION (WS8): WS7 moved the view domain live, but
// the loaded ROWS were still only those for the (old) settled window — so a
// horizontal PAN slid the domain over data that wasn't loaded yet (a blank LEADING
// edge), then the debounced refetch landed and the line RESIZED/morphed into place.
// WS8 kills both by DECOUPLING what's LOADED from what's SHOWN and preloading wide:
//   • LOADED SUPERSET (`load`): a window WIDER than the view — `[view.from − MARGIN,
//     view.to + MARGIN]` with MARGIN ≈ one VIEW-span per side (intervalOverscan), so
//     the loaded rows extend a full view-width past each visible edge.
//   • PANNING shifts the live `view` WITHIN that superset → instant, real data on
//     both edges, NO refetch in the loop, NOTHING to resize.
//   • A BACKGROUND extend-load fires only when the view nears a loaded edge
//     (isViewNearLoadedEdge, ~25% of MARGIN) OR a ZOOM changes the view-span bucket
//     (overscanBucketChanged): refetch a fresh superset RE-CENTERED on the view and
//     swap rows in WITHOUT moving the domain — the visible slice is identical data, so
//     the swap is invisible. The reconcile is DEBOUNCED + single-pending (`load`) and
//     the fetch layer dedupes one in-flight request per key, so rapid panning coalesces
//     to one fetch.
//   • GRAIN COHERENCE: the superset is aggregated at the VIEW's grain (the
//     view-span `chooseBucket`), passed as the route's `?bucket=` — NOT the wider
//     overscan span's grain (which would pick a coarser bucket and render the visible
//     slice too coarse). A zoom that changes the view bucket forces a fresh superset.
//   • The WS6 line-morph is REMOVED for navigation: <Line isAnimationActive={false}>
//     on every path. Smoothness is the live domain over preloaded data, not a tween.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  toHistoryPoints,
  formatGrain,
  formatHistoryLabel,
  type HistoryPoint,
} from '@/lib/intervalHistory';
import {
  classifyZoomSelection,
  zoomSpanToRange,
  viewDomainFor,
  type WindowMs,
} from '@/lib/intervalZoom';
import { intervalCacheKey } from '@/lib/intervalCache';
import { TOOLTIP_STYLE, AXIS_STYLE, FUEL_COLORS } from '@/lib/chartTheme';
import { useIntervalFetch } from '@/lib/hooks/useIntervalFetch';
import { useOverscanLoad } from '@/lib/hooks/useOverscanLoad';
import {
  useChartNavigation,
  CHART_MARGIN_LEFT,
  CHART_MARGIN_RIGHT,
  Y_AXIS_WIDTH,
} from '@/lib/hooks/useChartNavigation';
import { Segmented } from './Segmented';
import { ChartShell } from '../ChartShell';

// ---- Theme constants (shared via lib/chartTheme) ----------------------------
const ELEC = FUEL_COLORS.ELECTRIC;
const GAS = FUEL_COLORS.GAS;
const tooltipStyle = TOOLTIP_STYLE;
const axisStyle = AXIS_STYLE;

// ---- Zoom tuning ------------------------------------------------------------
// Hard minimum zoom window (issue #141). A deliberate drag whose span is below this
// floor is REFUSED (no zoom) and surfaces the "Max zoom reached" hint instead of
// silently doing nothing. 1 hour is the floor because the finest grain the data
// ever reaches is 15-min electric: an hour-wide window already shows the densest
// data the chart can hold (~4 points at 15-min), so a tighter band can't reveal
// anything new — it's the natural "you've hit max zoom" boundary. (A pure click is
// handled separately by classifyZoomSelection and stays silent.)
// NOTE: the wheel-zoom MIN_ZOOM_SPAN_MS lives in useChartNavigation; this copy gates
// the drag-select commit (commitDrag → classifyZoomSelection). Both are 1 hour.
const MIN_ZOOM_SPAN_MS = 60 * 60_000;

// How long the transient "Max zoom reached" hint stays up before auto-clearing.
const ZOOM_HINT_MS = 2_000;

// ---- WS8: the line-morph is GONE for navigation -----------------------------
// WS6 used to TWEEN the <Line> path (`animateSwap` → isAnimationActive true) when the
// debounced refetch swapped a new point-set in for a settled nav window. With WS7's
// view-domain decoupled from the loaded data, that tween became exactly the jarring
// "resize animation once the scroll finishes" the operator hates: a pan slid the view
// over data that wasn't loaded yet (a blank leading edge), then the refetch landed and
// the line visibly RESIZED/morphed into the new window.
//
// WS8 removes the morph entirely and gets smoothness from PRELOADED data instead:
//   • PAN now slides the live view domain over an OVERSCAN superset that already holds
//     real data on both sides (intervalOverscan), so there's no blank edge and no
//     data swap in the pan loop → nothing to morph.
//   • ZOOM scales the live domain over the loaded data; when a finer-grain superset
//     swaps in (a bucket change) the line just SHARPENS IN PLACE — the visible slice is
//     the same data at a finer resolution, so an instant swap (no morph) reads as a
//     crisp-up, not a resize.
// So the <Line> is now `isAnimationActive={false}` on every path. The WS2 SWR layer
// still keeps the prior chart on screen during a refetch (no cold blank), so removing
// the animation can't reintroduce a blank→line fade.

// ---- Types ------------------------------------------------------------------
type Fuel = 'ELECTRIC' | 'GAS';

const FUELS: readonly Fuel[] = ['ELECTRIC', 'GAS'];
const FUEL_LABEL: Record<Fuel, string> = { ELECTRIC: 'Electric', GAS: 'Gas' };
const FUEL_UNIT: Record<Fuel, string> = { ELECTRIC: 'kWh', GAS: 'therms' };

// The SWR fetch lifecycle (warm-cache hydrate, no-cold-blank revalidate, alive-guard)
// + its types (IntervalApiRow / Loaded / LoadState / toLoaded) live in the colocated
// useIntervalFetch hook (issue #156). The WS8 overscan LoadWindow type + its reconcile
// trio live in useOverscanLoad.

// A locally-zoomed window: the day bounds we refetched for finer detail, plus the
// raw ms span the user selected (so the reset/label can describe it). Ephemeral
// per-widget state — it never touches the global RangeControl.
type Zoom = { from: string; to: string; startMs: number; endMs: number };

// An in-progress drag-select on the main chart (WS7: numeric axis). With the
// numeric time XAxis, Recharts reports `e.activeLabel` as the `ts` VALUE (epoch-ms)
// of the nearest point — NOT the categorical `label` string it was before. So the
// band endpoints are now NUMBERS (ts). While this is non-null and `refX2` differs
// from `refX1`, we draw the selection <ReferenceArea x1/x2={ts}>.
type DragSel = { refX1: number; refX2: number | null };

// ---- Settings panel ---------------------------------------------------------
// Rendered inside ChartShell's Customize popover / expand side. Just the Fuel
// toggle now (WS2 removed the Resolution segmented control — the server picks the
// grain). The time window is GLOBAL (issue #36 — the dashboard RangeControl), so
// there's no per-widget range row.
function HistorySettings({ fuel, onFuel }: { fuel: Fuel; onFuel: (f: Fuel) => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Fuel</div>
        <Segmented
          options={FUELS.map((f) => ({ label: FUEL_LABEL[f], value: f }))}
          value={fuel}
          onChange={onFuel}
        />
      </div>
    </div>
  );
}

// ---- Main component ---------------------------------------------------------
// `from`/`to` are the GLOBAL RangeControl's resolved ISO day bounds (issue #36),
// supplied by the WidgetHost. Omitted (a non-dashboard caller) → the route falls
// back to its trailing 30-day window.
export function IntervalHistory({
  accountId,
  from,
  to,
}: {
  accountId?: number | null;
  from?: string;
  to?: string;
}) {
  const [fuel, setFuel] = useState<Fuel>('ELECTRIC');
  // The locally-zoomed window (issue #141). When set, the widget has refetched
  // /api/interval for [zoom.from, zoom.to] (finer detail) and renders that span.
  const [zoom, setZoom] = useState<Zoom | null>(null);
  // The in-progress drag-selection (issue #141). Non-null between onMouseDown and
  // onMouseUp; drives the <ReferenceArea> band. Committed (or discarded) on mouse up.
  const [drag, setDrag] = useState<DragSel | null>(null);
  // A brief, auto-dismissing "Max zoom reached" hint (issue #141), shown when a
  // deliberate drag is refused for being tighter than MIN_ZOOM_SPAN_MS.
  const [zoomHint, setZoomHint] = useState(false);

  // The chart-body wrapper element — the focus host. The navigation hook attaches the
  // native non-passive wheel + Ctrl+drag listeners here and we draw the focus ring on it.
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // The GLOBAL window bounds in epoch-ms (the outer clamp for every WS5 gesture).
  // Parsed from the day-string props; null when either bound is absent (a
  // non-dashboard caller using the route default) → gestures no-op (can't clamp).
  const boundsFromMs = useMemo(() => (from ? new Date(from).getTime() : NaN), [from]);
  const boundsToMs = useMemo(() => {
    if (!to) return NaN;
    // The route widens `to` to END-of-day (23:59:59.999Z), so the real right bound is
    // the last instant of the `to` day — match that so a zoom-out can reach it.
    const t = new Date(to).getTime();
    return Number.isFinite(t) ? t + (24 * 60 * 60_000 - 1) : NaN;
  }, [to]);
  const boundsValid = Number.isFinite(boundsFromMs) && Number.isFinite(boundsToMs);

  // ---- WS8: the overscan reconcile (colocated useOverscanLoad hook) ----------
  // Gestures move `zoom`/`view` immediately (live, no refetch); the hook's debounced
  // reconcile decides — via the pure overscan helpers — whether the view has panned
  // near a loaded edge or zoomed to a new bucket, and only THEN sets a new `load` (a
  // window WIDER than the view, at the view's grain). `load === null` ⇒ follow the
  // global window with no explicit bucket (initial/reset). `resetLoad` clears `load`
  // and the pending debounce synchronously for the context-change effect below.
  const { load, scheduleReconcile, resetLoad } = useOverscanLoad({
    boundsFromMs,
    boundsToMs,
    boundsValid,
  });

  // The window actually fetched (WS8): the LOADED SUPERSET window when set, else the
  // global window. The superset is WIDER than the visible view, so the rows the chart
  // holds always extend past both view edges → panning stays over real data.
  const fetchFrom = load ? load.from : from;
  const fetchTo = load ? load.to : to;
  // WS8: the explicit `?bucket=` for the fetch — the VIEW's grain, so the wider
  // superset is aggregated at the resolution the view needs (grain coherence). Absent
  // when no overscan load is active (the route picks the bucket from the span).
  const fetchBucket = load ? load.bucketSecs : undefined;

  // Build the /api/interval request (url + cache key). Follow the loaded OVERSCAN
  // superset window when set (WS8), else the GLOBAL range; otherwise let the route
  // default to its trailing window (non-dashboard caller). The cache key keys off the
  // FETCHED window + bucket (WS8) so an overscan superset and a base view (or two
  // buckets over the same window) are distinct cache entries.
  const acctQuery = accountId != null ? `&accountId=${accountId}` : '';
  const rangeQuery = fetchFrom && fetchTo ? `&from=${fetchFrom}&to=${fetchTo}` : '';
  const bucketQuery = fetchBucket != null ? `&bucket=${fetchBucket}` : '';
  const url = `/api/interval?fuel=${fuel}${rangeQuery}${bucketQuery}${acctQuery}`;
  const key = intervalCacheKey({ fuel, from: fetchFrom, to: fetchTo, accountId, bucket: fetchBucket });

  // ---- WS2 SWR fetch lifecycle (colocated useIntervalFetch hook) -------------
  // Warm-cache hydrate, no-cold-blank revalidate, alive-guard. `state` is the LoadState
  // the render tree narrows; `revalidating` drives the "updating" shimmer.
  const { state, revalidating } = useIntervalFetch(key, url);

  // Drop any active zoom (and any in-progress drag) whenever the fuel, the account,
  // or the GLOBAL range changes — a zoom into the old context would be stale. WS7:
  // also reset the live `view` to the new global bounds so the numeric axis domain
  // snaps to the fresh context (it's reconciled again when the fetch lands). WS8:
  // clear the loaded superset too (resetLoad) so the next reconcile loads a fresh one.
  // (panDragRef lives in the navigation hook now; resetLoad clears its debounce timer.)
  useEffect(() => {
    setZoom(null);
    setDrag(null);
    setZoomHint(false);
    resetLoad();
  }, [fuel, from, to, accountId, resetLoad]);

  // Auto-dismiss the "Max zoom reached" hint ~2s after it's shown (issue #141).
  useEffect(() => {
    if (!zoomHint) return;
    const id = setTimeout(() => setZoomHint(false), ZOOM_HINT_MS);
    return () => clearTimeout(id);
  }, [zoomHint]);

  const color = fuel === 'GAS' ? GAS : ELEC;
  const unit = FUEL_UNIT[fuel];

  // The server already chose the bucket and SUMMED energy into it (and shaped the
  // 15-min grid when zoomed in), so we map the rows STRAIGHT to chart points — no
  // client reconcile/filter/downsample. Missing rows = missing points (no zeros
  // fabricated; connectNulls=false renders gaps as line breaks).
  const data: HistoryPoint[] = useMemo(() => {
    if (!state || 'error' in state) return [];
    return toHistoryPoints(state.rows);
  }, [state]);

  const loading = state === undefined;
  const errored = !!state && 'error' in state;
  const empty = !loading && !errored && data.length === 0;

  // The chosen grain (seconds) and its human label for the subtitle/tooltip.
  const grainSecs = state && !('error' in state) ? state.grain : undefined;
  const grainLabel = formatGrain(grainSecs);

  // "Max zoom · finest detail" badge (issue #141): keyed off downsampled===false —
  // the server did NOT reduce the set, so the chart is at native resolution and
  // zooming further reveals nothing new. Suppressed while loading/errored/empty.
  const atFinestDetail =
    !!state && !('error' in state) && !state.downsampled && data.length > 0;

  // "End of 15-min data" marker (WS2 → WS7 numeric axis). The X axis is now a NUMERIC
  // TIME axis, so the <ReferenceLine> takes the RAW timestamp directly (`x={fmTs}`) —
  // no need to snap to a rendered point's categorical label. We only show it when:
  //   • fuel is ELECTRIC (there is no 15-min GAS data), AND
  //   • fifteenMinFrom is non-null + parseable, AND
  //   • fifteenMinFrom falls strictly WITHIN the loaded data extent (after the first
  //     point, before the last) so it isn't pinned to an axis edge for a window
  //     entirely before/after the 15-min band.
  // Out-of-window / null / Gas → null → no marker. Returns the numeric ts (epoch-ms).
  const fifteenMinMarkerTs: number | null = useMemo(() => {
    if (fuel !== 'ELECTRIC') return null;
    const fmFrom = state && !('error' in state) ? state.fifteenMinFrom : null;
    if (!fmFrom || data.length === 0) return null;
    const fmTs = new Date(fmFrom).getTime();
    if (!Number.isFinite(fmTs)) return null;
    const firstTs = data[0].ts;
    const lastTs = data[data.length - 1].ts;
    // Strictly inside the band: a marker exactly at the left edge would just overlap
    // the axis (the whole window is 15-min); at/after the right edge it's off-window.
    if (fmTs <= firstTs || fmTs >= lastTs) return null;
    return fmTs;
  }, [fuel, state, data]);

  // Look up a rendered point's index by its ts (WS7: numeric axis). With the numeric
  // time XAxis, Recharts reports `e.activeLabel` as the `ts` VALUE of the nearest
  // point (not the categorical `label` string it used to). The drag handlers map that
  // ts back to the underlying point's index — needed by classifyZoomSelection's
  // distinct-index check. A Map keeps the lookup O(1) per move event.
  const indexByTs = useMemo(() => {
    const m = new Map<number, number>();
    data.forEach((p, i) => {
      if (!m.has(p.ts)) m.set(p.ts, i);
    });
    return m;
  }, [data]);

  // Resolve a Recharts `activeLabel` (a ts value, possibly stringified) to a
  // { ts, index } for the nearest rendered point. Returns null when the chart has no
  // data or the value isn't a finite ts we can map. WS7 helper shared by the drag /
  // pan handlers (replaces the old label-string lookup).
  const pointFromActive = useCallback(
    (active: string | number | undefined | null): { ts: number; index: number } | null => {
      if (active == null) return null;
      const ts = typeof active === 'number' ? active : Number(active);
      if (!Number.isFinite(ts)) return null;
      const idx = indexByTs.get(ts);
      if (idx == null) return null;
      return { ts, index: idx };
    },
    [indexByTs],
  );

  // The CURRENT window in epoch-ms: the live zoom span when zoomed, else the global
  // bounds. This is the window every WS5 gesture transforms (zoom/pan) before
  // re-clamping to the bounds. (`zoom` carries startMs/endMs; the global window is
  // boundsFromMs..boundsToMs.)
  const curFromMs = zoom ? zoom.startMs : boundsFromMs;
  const curToMs = zoom ? zoom.endMs : boundsToMs;

  // WS10: a FRESH mirror of the current window for the native Ctrl+drag listener.
  // The native mousedown/move/up listener is bound once (it needs `e.clientX` + the
  // plot geometry, which Recharts' synthetic state doesn't give reliably), so it must
  // capture the LATEST window at mousedown without re-binding on every `zoom` change.
  const curWindowRef = useRef<{ fromMs: number; toMs: number }>({ fromMs: curFromMs, toMs: curToMs });
  useEffect(() => {
    curWindowRef.current = { fromMs: curFromMs, toMs: curToMs };
  }, [curFromMs, curToMs]);

  // ---- WS7: the LIVE numeric-axis domain ------------------------------------
  // The X-axis `domain` is DERIVED from the live `zoom` window (or the global bounds
  // when not zoomed) via the PURE viewDomainFor — NOT separate state. Because every
  // gesture sets `zoom` IMMEDIATELY (applyNavWindow / commitDrag run synchronously,
  // ahead of the debounced refetch), this memo recomputes on every wheel-notch /
  // drag-move, so the numeric domain — and therefore the rendered line — slides /
  // scales LIVE under the *currently-loaded* data. The debounced refetch later swaps
  // finer rows in for the settled window; the domain already matches it, so the swap
  // just sharpens the line in place (no jump). `null` ⇒ no explicit domain → Recharts
  // auto-fits to the data (the non-dashboard / no-bounds caller). PURE-derived.
  const view = useMemo(
    () => viewDomainFor(zoom ? zoom.startMs : null, zoom ? zoom.endMs : null, boundsFromMs, boundsToMs),
    [zoom, boundsFromMs, boundsToMs],
  );
  // The concrete numeric domain handed to <XAxis domain>. When `view` is null
  // (no bounds, no zoom) we fall back to Recharts' auto-fit sentinels so the axis
  // still spans the loaded data instead of collapsing.
  const xDomain: [number | 'dataMin', number | 'dataMax'] = view
    ? [view.fromMs, view.toMs]
    : ['dataMin', 'dataMax'];

  // ---- WS5/WS8: apply a gesture-produced ms window --------------------------
  // Clamp the new [fromMs,toMs] to the global bounds + min span, then:
  //   • if it reaches/exceeds the FULL global window → CLEAR the zoom (== Reset, the
  //     "Reset zoom" affordance hides) and reconcile back to the global window;
  //   • else → set the LIVE zoom immediately (the numeric domain / line move LIVE) and
  //     DEBOUNCE the OVERSCAN reconcile (WS8): a pan that stays inside the loaded
  //     superset triggers NO refetch; one that nears a loaded edge (or a zoom that
  //     changes the grain) tops the superset back up. `runNow` forces a synchronous
  //     reconcile (discrete gestures: drag-select commit / reset — no flurry).
  // WS8: the live `zoom` always moves so the domain slides/scales over the PRELOADED
  // overscan data; the reconcile only decides whether to fetch MORE, never blanks.
  const applyNavWindow = useCallback(
    (next: WindowMs, runNow = false) => {
      if (!boundsValid) return;
      const lo = next.fromMs;
      const hi = next.toMs;
      // Reached the full global window (within a 1s slop) → equivalent to Reset.
      if (lo <= boundsFromMs + 1000 && hi >= boundsToMs - 1000) {
        setDrag(null);
        setZoom(null);
        // WS11: keep the fresh window mirror in lockstep SYNCHRONOUSLY — a reset means
        // the current window is the global bounds. (The `[curFromMs,curToMs]` effect
        // also syncs it on the next commit; writing here makes a same-burst follow-up
        // wheel/drag read the just-applied window instead of a one-commit-stale value.)
        curWindowRef.current = { fromMs: boundsFromMs, toMs: boundsToMs };
        scheduleReconcile(null, runNow); // null view → follow the global window
        return;
      }
      const { from: zf, to: zt } = zoomSpanToRange(lo, hi);
      const z: Zoom = { from: zf, to: zt, startMs: lo, endMs: hi };
      setZoom((prev) =>
        prev && prev.startMs === lo && prev.endMs === hi ? prev : z,
      );
      // WS11: mirror the just-committed window into the fresh ref SYNCHRONOUSLY so a
      // back-to-back wheel notch (a burst that fires before React commits `setZoom`)
      // ACCUMULATES from this window, not the last-committed one — a clean constant-span
      // slide per notch. The `[curFromMs,curToMs]` effect still reconciles it on commit.
      curWindowRef.current = { fromMs: lo, toMs: hi };
      // WS8: hand the reconcile the NEXT view window explicitly (the gesture's result)
      // so it doesn't depend on React having committed `zoom`.
      scheduleReconcile({ fromMs: lo, toMs: hi }, runNow);
    },
    [boundsValid, boundsFromMs, boundsToMs, scheduleReconcile],
  );

  // ---- WS5–WS11 mouse navigation (colocated useChartNavigation hook) ---------
  // The two native non-passive listeners (wheel zoom/shift-pan + Ctrl+drag pan) and the
  // focus/modifier tracking live in the hook. It reads the FRESH `curWindowRef` (never a
  // stale `zoom` closure) for the constant-span slide, reads focus from a fresh ref so
  // the first shift+wheel after a click still preventDefault()s, treats a horizontal
  // wheel (macOS shift+scroll, shiftKey=false) as a pan, and stopPropagation()s so the
  // cockpit paginator can't steal the horizontal wheel. It returns the focus state +
  // setter, the chart cursor, and the refs the drag-select handlers below also read.
  const {
    focused,
    setFocused,
    chartCursor,
    hoverTsRef,
    panDragRef,
    ctrlDownRef,
    onBodyMouseEnter,
    onBodyMouseLeave,
  } = useChartNavigation(
    bodyRef,
    curWindowRef,
    applyNavWindow,
    { boundsFromMs, boundsToMs, boundsValid },
    data.length,
  );

  // ---- Drag handlers (issue #141 zoom-select; WS10 Ctrl+drag pan is native) --
  // Mouse-down focuses the chart (WS5). The Ctrl+drag PAN is NO LONGER handled here —
  // WS10 moved it to a NATIVE mousedown/move/up listener on the chart body, because
  // the pan needs the raw `clientX` + plot pixel geometry (Recharts' synthetic
  // `activeLabel` only gives the nearest DATA POINT's ts against the LIVE-moving
  // domain, which fed back into the next delta and made the pan snap back / glitch).
  // So here we only START the plain zoom-SELECT band, and ONLY when Ctrl isn't held
  // (a Ctrl+down is owned by the native pan listener, which also `setCtrlDragging`).
  const onChartMouseDown = useCallback(
    (e: { activeLabel?: string | number } | null) => {
      setFocused(true);
      // Ctrl+down → the native pan listener owns this gesture; don't start a band.
      if (ctrlDownRef.current) return;
      // WS7: with the numeric axis, activeLabel is the ts of the nearest point.
      const pt = pointFromActive(e?.activeLabel);
      if (!pt) return;
      // Plain drag → the existing zoom-select band (WS7: numeric ts endpoints).
      setDrag({ refX1: pt.ts, refX2: null });
    },
    [pointFromActive],
  );

  const onChartMouseMove = useCallback(
    (e: { activeLabel?: string | number } | null) => {
      // WS7: activeLabel is the nearest point's ts under the numeric axis.
      const pt = pointFromActive(e?.activeLabel);
      // Always track the time under the cursor for the wheel-zoom center (WS5).
      if (pt) hoverTsRef.current = pt.ts;
      // WS10: the Ctrl+drag PAN is handled by the native listener now, so if a pan is
      // in flight, do NOT also run the band logic (the native listener suppressed the
      // band at mousedown, but guard here too).
      if (panDragRef.current) return;
      // Plain zoom-SELECT band (issue #141). WS7: endpoints are numeric ts now.
      if (!drag) return;
      if (!pt) return;
      const next = pt.ts;
      setDrag((prev) => (prev && prev.refX2 !== next ? { ...prev, refX2: next } : prev));
    },
    [drag, pointFromActive],
  );

  const commitDrag = useCallback(() => {
    // WS10: a Ctrl+drag pan is committed by the native mouseup handler now, not here.
    // If one is somehow still in flight when Recharts fires mouseup/leave, just bail
    // (the band logic must not run during a pan).
    if (panDragRef.current) return;
    setDrag((sel) => {
      // Three cases (issue #141), decided by the PURE classifyZoomSelection:
      //   • 'click'     — silent no-op (no zoom, no hint).
      //   • 'too-small' — a deliberate drag below the floor → refuse + show hint.
      //   • 'zoom'      — productive drag → commit the zoom + refetch.
      if (!sel || sel.refX2 == null) return null;
      // WS7: the band endpoints are ts values; map each to its point index for the
      // distinct-index (click vs drag) check, and use the ts directly for the span.
      const aIdx = indexByTs.get(sel.refX1);
      const bIdx = indexByTs.get(sel.refX2);
      if (aIdx == null || bIdx == null || sel.refX2 === sel.refX1) return null;
      const aTs = sel.refX1;
      const bTs = sel.refX2;
      const kind = classifyZoomSelection(aIdx, bIdx, aTs, bTs, MIN_ZOOM_SPAN_MS);
      if (kind === 'click') return null;
      if (kind === 'too-small') {
        setZoomHint(true);
        return null;
      }
      const { from: zf, to: zt } = zoomSpanToRange(aTs, bTs);
      const startMs = Math.min(aTs, bTs);
      const endMs = Math.max(aTs, bTs);
      const z: Zoom = { from: zf, to: zt, startMs, endMs };
      setZoom((prev) => (prev && prev.from === zf && prev.to === zt ? prev : z));
      // WS8: a committed drag-zoom-select is a discrete nav gesture → reconcile the
      // overscan load synchronously (no flurry to debounce). overscanBucketChanged
      // forces a fresh superset at the new (finer) grain; the line sharpens in place,
      // no morph.
      scheduleReconcile({ fromMs: startMs, toMs: endMs }, true);
      return null;
    });
  }, [indexByTs, scheduleReconcile]);

  const resetZoom = useCallback(() => {
    setDrag(null);
    setZoom(null);
    panDragRef.current = null;
    // WS8: Reset → reconcile back to the global window synchronously (clears `load`).
    scheduleReconcile(null, true);
  }, [scheduleReconcile]);

  // Subtitle: e.g. "Electric · kWh · hourly" (the global time window is in the
  // dashboard header). The grain segment is human-formatted from the numeric
  // `grain` (WS2) and omitted when absent. When zoomed, append the local span.
  const subtitle = `${FUEL_LABEL[fuel]} · ${unit}${grainLabel ? ` · ${grainLabel}` : ''}${
    zoom ? ` · zoomed ${zoom.from} → ${zoom.to}` : ''
  }`;

  // Empty-state message. There's only one grain now (server-chosen), so a single
  // friendly line regardless of resolution.
  const emptyMsg = `No interval data yet for ${FUEL_LABEL[
    fuel
  ].toLowerCase()} — it's collected on each scheduled check.`;

  // Tooltip formatter: value + unit + the grain so the user sees the resolution of
  // the point under the cursor (e.g. "1.234 kWh · hourly").
  const tooltipFormatter = (v: number | string): [string, string] => [
    `${Number(v).toFixed(3)} ${unit}${grainLabel ? ` · ${grainLabel}` : ''}`,
    'usage',
  ];

  // WS7: the tooltip's header label is now the numeric `ts` (the numeric axis reports
  // the x value, not the old `label` string), so format it back to the SAME
  // "Jun 8 14:00" style the categorical label used — reusing formatHistoryLabel so the
  // header reads identically to before. Non-numeric / non-finite → passthrough.
  const tooltipLabelFormatter = (l: number | string): string => {
    const ts = typeof l === 'number' ? l : Number(l);
    return Number.isFinite(ts) ? formatHistoryLabel(ts) : `${l}`;
  };

  // WS7: numeric-axis TICK formatter — the axis ticks are `ts` values now; format them
  // with the SAME label style (reused formatHistoryLabel) so tick text reads exactly
  // as the old categorical `label` did. Non-finite ticks degrade to an empty string.
  const xTickFormatter = (ts: number): string =>
    Number.isFinite(ts) ? formatHistoryLabel(ts) : '';

  // The chart body (render-prop for ChartShell): the loading/empty/errored states,
  // the revalidate shimmer, the overlay badges, and the Recharts tree.
  const renderBody = (h: number | string) => (
    <div
      ref={bodyRef}
      style={{ height: h }}
      // WS5 focus host: a click anywhere on the body focuses it (the document
      // pointerdown/Esc listeners release it); the native wheel listener is bound to
      // this element. The amber focus RING (rounded to match the card) signals that
      // wheel-zoom / shift-pan / ctrl-drag are live. The wrapper itself is just a
      // positioned container — it does NOT block the SVG's pointer events, so the
      // drag-zoom select still works (the ring is a box-shadow, not an overlay).
      className={`relative w-full rounded-lg transition-shadow ${
        focused ? 'ring-2 ring-amber-500/40' : ''
      }`}
      onMouseDown={() => setFocused(true)}
      // WS9 (Fix 1): track hover so the shift+wheel PAN is discoverable on hover — the
      // modifier cursor (ew-resize / grab) shows via navCursor's `hovering` even before
      // the chart is clicked-to-focus.
      onMouseEnter={onBodyMouseEnter}
      onMouseLeave={onBodyMouseLeave}
    >
      {/* Subtle "updating" shimmer (WS2): a thin top progress bar shown whenever a
          revalidation is in flight AND there's already a chart up — so a reload
          NEVER cold-blanks. Pointer-events-none so it can't intercept the drag. */}
      {revalidating && !loading && !errored && (
        <div
          title="Updating…"
          className="pointer-events-none absolute inset-x-0 top-0 z-20 h-0.5 overflow-hidden"
        >
          <div className="h-full w-1/3 animate-pulse rounded-full bg-amber-500/70" />
        </div>
      )}
      {/* Reset-zoom affordance (issue #141): overlaid top-left, shown only when a
          local zoom is active. Returns to the global RangeControl window. */}
      {zoom && !loading && !errored && (
        <button
          onClick={resetZoom}
          title="Reset zoom to the dashboard range"
          className="absolute left-1 top-1 z-10 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-0.5 text-[11px] text-slate-200 backdrop-blur transition hover:bg-slate-700"
        >
          Reset zoom
        </button>
      )}
      {/* Persistent "finest detail" badge (issue #141): shown whenever the server
          did NOT downsample. Sits top-right, opposite the Reset-zoom affordance. */}
      {atFinestDetail && (
        <div
          title="The chart is at its finest available resolution — zooming further won't reveal more detail."
          className="pointer-events-none absolute right-1 top-1 z-10 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-0.5 text-[11px] text-slate-400 backdrop-blur"
        >
          Max zoom · finest detail
        </div>
      )}
      {/* Transient refused-drag hint (issue #141): shown ~2s when a deliberate drag
          is tighter than the zoom floor. Centered at the top as a momentary toast. */}
      {zoomHint && !loading && !errored && (
        <div className="pointer-events-none absolute left-1/2 top-1 z-20 -translate-x-1/2 rounded-md border border-amber-500/60 bg-slate-900/90 px-2 py-0.5 text-[11px] text-amber-300 backdrop-blur">
          Max zoom reached
        </div>
      )}
      {/* In-grid GRAIN indicator (WS2b): an always-rendered overlay pill naming the
          server-chosen resolution the user is currently viewing (e.g. "15-min",
          "hourly", "weekly"). ChartShell only paints its subtitle when NOT `fill`,
          so the grain in the subtitle is invisible on the in-grid (fill) card — it
          only surfaces in the Expand modal. This pill closes that gap at-a-glance.
          Absolutely-positioned (no layout height → can't break the fit-cockpit
          sizing) and pointer-events-none (mustn't intercept the drag-zoom). Pinned
          BOTTOM-LEFT: the one free corner (Reset-zoom is top-left, the finest-detail
          badge top-right, the "Max zoom reached" hint top-center, the "15-min data →"
          ReferenceLine label rides the plot). Rendered only with real data and a
          valid grain (formatGrain returns '' for an absent/odd grain → omit). Styled
          like the sibling overlay pills. Redundant with the Expand-modal subtitle by
          design (WS2b: render in both, don't detect fill-vs-expand). */}
      {!loading && !errored && data.length > 0 && grainLabel && (
        <div
          title="Current chart resolution (the server picks the bucket from the visible window)."
          className="pointer-events-none absolute bottom-1 left-1 z-10 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-0.5 text-[11px] text-slate-400 backdrop-blur"
        >
          {grainLabel}
        </div>
      )}
      {loading ? (
        <div className="flex h-full w-full items-center justify-center">
          <div className="h-full w-full animate-pulse rounded-lg bg-slate-800/40" />
        </div>
      ) : errored ? (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-xs text-slate-400">
          Couldn&apos;t load interval data — try again on the next check.
        </div>
      ) : empty ? (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-slate-400">
          <span>{emptyMsg}</span>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          {/* Drag-to-select-zoom (issue #141): mouse-down records the start x,
              mouse-move tracks it while dragging, mouse-up commits. onMouseLeave
              also commits so a drag that ends just off the plot still zooms. */}
          <LineChart
            data={data}
            margin={{ top: 5, right: CHART_MARGIN_RIGHT, left: CHART_MARGIN_LEFT, bottom: 0 }}
            onMouseDown={onChartMouseDown}
            onMouseMove={onChartMouseMove}
            onMouseUp={commitDrag}
            onMouseLeave={commitDrag}
            // WS6: the cursor is now MODAL — it reflects the held modifier while the
            // chart is focused (grab/grabbing for Ctrl, ew-resize for Shift, crosshair
            // for a plain focused drag, default when unfocused). navCursor() resolves
            // it from {focused, ctrlDown, shiftDown, ctrlDragging}; userSelect:none
            // still prevents text-selection during a drag.
            style={{ cursor: chartCursor, userSelect: 'none' }}
          >
            <CartesianGrid stroke="#1e293b" vertical={false} />
            {/* WS7: NUMERIC TIME X axis. `dataKey="ts"` + type="number" + scale="time"
                with an explicit `domain={[view.fromMs, view.toMs]}` and
                `allowDataOverflow` decouples the rendered WINDOW from the loaded DATA:
                the domain comes from the live `view` (derived from the zoom window), so
                a gesture that moves `view` slides/scales the line LIVE under the
                currently-loaded points, and `allowDataOverflow` CLIPS points outside the
                domain (instead of forcing the axis to span all data). Ticks reuse the
                old label style via xTickFormatter so they read identically. */}
            <XAxis
              dataKey="ts"
              type="number"
              scale="time"
              domain={xDomain}
              allowDataOverflow
              tickFormatter={xTickFormatter}
              {...axisStyle}
              minTickGap={40}
              interval="preserveStartEnd"
            />
            <YAxis
              {...axisStyle}
              width={Y_AXIS_WIDTH}
              // One precision now (server-chosen grain). 2 decimals reads well for
              // both the small 15-min kWh values and the larger coarse-bucket sums.
              tickFormatter={(v: number) => Number(v).toFixed(2)}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={tooltipFormatter}
              // WS7: the tooltip header is the numeric `ts` now → format it to the same
              // "Jun 8 14:00" style via formatHistoryLabel so it reads as before.
              labelFormatter={tooltipLabelFormatter}
            />
            {/* connectNulls={false} is load-bearing: missing intervals must render
                as line BREAKS, never as straight lines over a gap or fabricated
                zeros. Explicit here to guard against future defaults changing. */}
            <Line
              type="monotone"
              dataKey="value"
              name="usage"
              stroke={color}
              strokeWidth={1.5}
              dot={false}
              // WS8: NO animation on ANY path. The WS6 line-morph was the "resize once
              // the scroll stops" the operator hated — with WS7's view-domain decoupled
              // from the data, a pan's debounced swap visibly RESIZED the line. WS8's
              // smoothness comes from PRELOADED overscan data: pan slides the live view
              // domain over a wider loaded superset (no swap in the loop → nothing to
              // resize), and a finer-grain zoom swap just sharpens in place. An instant
              // swap is invisible because the visible slice is the SAME data (the
              // overscan reload is re-centered on the view, the view domain never moves).
              // The WS2 SWR layer still keeps the prior chart up during a refetch, so
              // `false` here can't reintroduce a blank→line fade.
              isAnimationActive={false}
              connectNulls={false}
            />
            {/* "End of 15-min data" marker (WS2): a vertical reference line at the
                first point where true 15-min detail begins (electric only, and only
                when that boundary falls inside the visible window). Drawn AFTER the
                Line so it sits on top; the label points right ("15-min data →")
                toward the finer-resolution side. WS7: `x` is the raw numeric ts now
                (the X axis is a numeric time axis), so the line lands exactly at the
                15-min boundary instant. */}
            {fifteenMinMarkerTs != null && (
              <ReferenceLine
                x={fifteenMinMarkerTs}
                stroke="#94a3b8"
                strokeDasharray="4 3"
                strokeOpacity={0.7}
                label={{
                  value: '15-min data →',
                  position: 'insideTopLeft',
                  fill: '#94a3b8',
                  fontSize: 10,
                }}
              />
            )}
            {/* The in-progress drag-selection band (issue #141). WS7: x1/x2 are
                numeric ts values now (the numeric axis takes raw timestamps). */}
            {drag && drag.refX2 != null && drag.refX2 !== drag.refX1 && (
              <ReferenceArea
                x1={drag.refX1}
                x2={drag.refX2}
                strokeOpacity={0.3}
                stroke={color}
                fill={color}
                fillOpacity={0.12}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      )}
    </div>
  );

  return (
    <ChartShell
      title="Usage history"
      subtitle={subtitle}
      fill
      body={renderBody}
      settings={<HistorySettings fuel={fuel} onFuel={setFuel} />}
    />
  );
}
