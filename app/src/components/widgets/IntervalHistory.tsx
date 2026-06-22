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
import { type IntervalProfileRow } from '@/lib/intervalProfile';
import {
  toHistoryPoints,
  formatGrain,
  formatHistoryLabel,
  type HistoryPoint,
} from '@/lib/intervalHistory';
import {
  classifyZoomSelection,
  zoomSpanToRange,
  zoomWindowAroundCenter,
  panWindow,
  pixelPanDeltaMs,
  navCursor,
  viewDomainFor,
  msToYmd,
  type WindowMs,
} from '@/lib/intervalZoom';
import {
  getCached,
  swrFetch,
  intervalCacheKey,
  type IntervalResponse,
} from '@/lib/intervalCache';
import {
  overscanWindowFor,
  isViewNearLoadedEdge,
  viewSpanBucketSecs,
  overscanBucketChanged,
  type OverscanWindow,
} from '@/lib/intervalOverscan';
import { MAX_POINTS } from '@/lib/viz/downsampleInterval';
import { TOOLTIP_STYLE, AXIS_STYLE, FUEL_COLORS } from '@/lib/chartTheme';
import { useDismissable } from '@/lib/hooks/useDismissable';
import { Segmented } from './Segmented';
import { ChartShell } from '../ChartShell';

// ---- Theme constants (shared via lib/chartTheme) ----------------------------
const ELEC = FUEL_COLORS.ELECTRIC;
const GAS = FUEL_COLORS.GAS;
const tooltipStyle = TOOLTIP_STYLE;
const axisStyle = AXIS_STYLE;

// ---- WS10: plot pixel geometry ----------------------------------------------
// The Ctrl+drag pan (WS10) converts a raw pixel delta into a window shift, so it
// needs the PLOT's pixel width (the drawable area inside the axes). We derive it
// from the chart body's measured width minus the horizontal insets that aren't
// plot: the LineChart `margin.left`/`margin.right` plus the YAxis `width`. These
// MUST mirror the values on the <LineChart margin> and <YAxis width> below — they
// only scale pan sensitivity, so an exact match isn't critical, but keep them in
// sync. (The X axis sits at the bottom, so it doesn't eat horizontal plot width.)
const CHART_MARGIN_LEFT = 0;
const CHART_MARGIN_RIGHT = 10;
const Y_AXIS_WIDTH = 42;
// Total horizontal pixels reserved for chrome (everything that isn't plot width).
const PLOT_X_INSET = CHART_MARGIN_LEFT + CHART_MARGIN_RIGHT + Y_AXIS_WIDTH;

// ---- Zoom tuning ------------------------------------------------------------
// Hard minimum zoom window (issue #141). A deliberate drag whose span is below this
// floor is REFUSED (no zoom) and surfaces the "Max zoom reached" hint instead of
// silently doing nothing. 1 hour is the floor because the finest grain the data
// ever reaches is 15-min electric: an hour-wide window already shows the densest
// data the chart can hold (~4 points at 15-min), so a tighter band can't reveal
// anything new — it's the natural "you've hit max zoom" boundary. (A pure click is
// handled separately by classifyZoomSelection and stays silent.)
const MIN_ZOOM_SPAN_MS = 60 * 60_000;

// How long the transient "Max zoom reached" hint stays up before auto-clearing.
const ZOOM_HINT_MS = 2_000;

// ---- WS5 mouse-navigation tuning --------------------------------------------
// Wheel zoom step: the multiplier applied to the current span PER notch. Zoom-in
// contracts the span to 88% (factor 0.88 ≈ a 12% tighter window); zoom-out is the
// reciprocal (≈1.136). ~10–18% is a good feel; 12% is the middle.
const WHEEL_ZOOM_IN_FACTOR = 0.88;
const WHEEL_ZOOM_OUT_FACTOR = 1 / WHEEL_ZOOM_IN_FACTOR;
// Shift+wheel pan step: shift the window by this fraction of its CURRENT span per
// notch (~10–15%). Sign comes from the wheel deltaY direction.
const WHEEL_PAN_FRACTION = 0.12;
// Debounce for the gesture-driven refetch: update the display window instantly,
// but coalesce a flurry of wheel/pan ticks into ONE /api/interval request after the
// gestures settle. The route is ~15–40ms so this stays snappy.
const NAV_REFETCH_DEBOUNCE_MS = 150;

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

// The /api/interval payload rows (fuelType + unit from the API, plus the
// IntervalProfileRow fields toHistoryPoints needs).
type IntervalApiRow = IntervalProfileRow & { fuelType?: string; unit?: string };

// What the widget keeps in component state once it has a response. We normalize the
// SWR-cache payload (IntervalResponse, whose `rows` are `unknown[]`) into the typed
// rows + the WS1 metadata the UI reads. `error: true` is a distinct terminal state.
type Loaded = {
  rows: IntervalApiRow[];
  grain: number | undefined; // chosen bucket width in seconds (WS1); undefined if absent
  fifteenMinFrom: string | null; // earliest 15-min timestamp, or null
  downsampled: boolean; // finer detail exists than what's shown
};
type LoadState = Loaded | { error: true } | undefined;

// A locally-zoomed window: the day bounds we refetched for finer detail, plus the
// raw ms span the user selected (so the reset/label can describe it). Ephemeral
// per-widget state — it never touches the global RangeControl.
type Zoom = { from: string; to: string; startMs: number; endMs: number };

// WS8 OVERSCAN: the LOADED SUPERSET descriptor — what /api/interval was actually
// fetched for, DECOUPLED from the visible view. It's a window WIDER than the view
// (`overscanWindowFor`) aggregated at the VIEW's grain (`bucketSecs`), so panning
// within it stays over real data with no refetch (no blank edge, no resize). The
// view-domain (`view`) is what's SHOWN; this is what's LOADED. `null` = follow the
// global window with no explicit bucket (the initial / reset state). `bucketSecs` is
// sent as the `?bucket=` param so the wider window keeps the view's resolution; we
// recompute it from the view span and reload when a ZOOM changes the bucket.
type LoadWindow = { from: string; to: string; bucketSecs: number };

// An in-progress drag-select on the main chart (WS7: numeric axis). With the
// numeric time XAxis, Recharts reports `e.activeLabel` as the `ts` VALUE (epoch-ms)
// of the nearest point — NOT the categorical `label` string it was before. So the
// band endpoints are now NUMBERS (ts). While this is non-null and `refX2` differs
// from `refX1`, we draw the selection <ReferenceArea x1/x2={ts}>.
type DragSel = { refX1: number; refX2: number | null };

// Narrow a cached/fetched IntervalResponse into the typed Loaded the UI reads.
// Centralized so the cache-hydrate path and the revalidate path agree.
function toLoaded(resp: IntervalResponse): Loaded {
  return {
    rows: Array.isArray(resp.rows) ? (resp.rows as IntervalApiRow[]) : [],
    grain: typeof resp.grain === 'number' ? resp.grain : undefined,
    fifteenMinFrom: resp.fifteenMinFrom ?? null,
    // Absent flag → treat as native resolution (badge shown). Matches WS1's intent:
    // a missing `downsampled` means nothing was reported reduced.
    downsampled: resp.downsampled === true,
  };
}

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
  const [state, setState] = useState<LoadState>(undefined);
  // `revalidating` (WS2): true while a fetch is in flight AND we already have data
  // on screen — drives the subtle "updating" shimmer instead of a cold skeleton.
  const [revalidating, setRevalidating] = useState(false);
  // The locally-zoomed window (issue #141). When set, the widget has refetched
  // /api/interval for [zoom.from, zoom.to] (finer detail) and renders that span.
  const [zoom, setZoom] = useState<Zoom | null>(null);
  // The in-progress drag-selection (issue #141). Non-null between onMouseDown and
  // onMouseUp; drives the <ReferenceArea> band. Committed (or discarded) on mouse up.
  const [drag, setDrag] = useState<DragSel | null>(null);
  // A brief, auto-dismissing "Max zoom reached" hint (issue #141), shown when a
  // deliberate drag is refused for being tighter than MIN_ZOOM_SPAN_MS.
  const [zoomHint, setZoomHint] = useState(false);

  // ---- WS5 navigation state -------------------------------------------------
  // Whether the chart is FOCUSED (clicked). The wheel/pan gestures engage ONLY
  // while focused, and the native wheel listener captures page-scroll ONLY while
  // focused — so scrolling past an unfocused chart is never trapped.
  const [focused, setFocused] = useState(false);
  // WS7: a FRESH mirror of `focused` for the native wheel listener. The listener's
  // closure can be stale right after a click focuses the chart (the effect that
  // re-binds it on `focused` hasn't run yet), which let the very first shift+wheel
  // leak through to the page. Reading this ref means preventDefault() is never
  // skipped for a focused chart due to a stale closure. Kept in sync below.
  const focusedRef = useRef(false);
  // WS8 OVERSCAN: the LOADED SUPERSET that actually drives the fetch (replacing WS5's
  // `fetchZoom`). Gestures move `zoom`/`view` immediately (live, no refetch); a
  // DEBOUNCED reconcile (`reconcileLoad`) decides — via the pure overscan helpers —
  // whether the view has panned near a loaded edge or zoomed to a new bucket, and only
  // THEN sets a new `load` (a window WIDER than the view, at the view's grain). A pan
  // that stays inside the loaded superset sets nothing, so there's no refetch in the
  // loop. `null` ⇒ follow the global window with no explicit bucket (initial/reset).
  const [load, setLoad] = useState<LoadWindow | null>(null);

  // ---- WS6 navigation polish state ------------------------------------------
  // Reactive modifier/drag state, used ONLY to derive the chart cursor (the GESTURE
  // logic still reads the always-fresh refs below). `ctrlDown`/`shiftDown` mirror the
  // held modifiers; `ctrlDragging` is true while a Ctrl+drag pan is actually in
  // flight. We keep these as state (not refs) because the cursor must RE-RENDER when a
  // key is pressed/released. navCursor({focused,…}) maps them to the CSS cursor.
  const [ctrlDown, setCtrlDown] = useState(false);
  const [shiftDown, setShiftDown] = useState(false);
  const [ctrlDragging, setCtrlDragging] = useState(false);
  // WS9 (Fix 1): whether the cursor is currently OVER the chart body. Drives the
  // modifier-cursor hint on hover (navCursor's `hovering`). The native wheel listener
  // captures the shift+wheel PAN on hover regardless of focus simply because the
  // listener only fires for wheel events delivered to the body — so the cursor must be
  // over it — which is why no separate hover ref is needed there; this state is purely
  // for the discoverable modifier cursor (the operator naturally shift+scrolls on
  // hover, and the old `!focusedRef.current → return` gate leaked that to the page).
  const [hovering, setHovering] = useState(false);
  // WS8: the WS6 line-morph (`animateNextRef`/`animateSwap`) is GONE — see the WS8
  // header note. Nav-driven swaps now happen WITHOUT animation: pan slides the view
  // over a preloaded overscan superset (no swap in the loop), and a finer-grain zoom
  // swap just sharpens in place. <Line isAnimationActive={false}> on every path.

  // The chart-body wrapper element — the focus host. We attach the native
  // non-passive wheel listener here and draw the focus ring on it.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The time (epoch-ms) under the cursor, tracked from the Recharts onMouseMove via
  // pointFromActive. The wheel handler uses it as the zoom center (fallback: midpoint).
  const hoverTsRef = useRef<number | null>(null);
  // Whether Ctrl is currently held — tracked from document keydown/keyup AND from the
  // native mouse/wheel events, because Recharts' synthetic mouse-state object doesn't
  // reliably expose modifier keys. Drives the Ctrl+drag pan branch.
  const ctrlDownRef = useRef(false);
  // The in-flight Ctrl+drag pan, if any (WS10: PIXEL-ANCHORED). Captured at native
  // mousedown: the START window (`fromMs`/`toMs`), the START cursor `clientX`, and the
  // plot's pixel width. Every move computes `deltaPx = e.clientX - startClientX`,
  // converts it to ms via the START span (pixelPanDeltaMs), and shifts the START
  // window — so there's NO feedback loop (the old version derived the delta from the
  // nearest data point's ts against the LIVE-moving domain, which oscillated and
  // snapped back). While set, the Recharts plain drag-select is suppressed.
  const panDragRef = useRef<{
    startClientX: number;
    fromMs: number;
    toMs: number;
    plotWidthPx: number;
  } | null>(null);
  // The debounce timer handle for the gesture refetch.
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The window actually fetched (WS8): the LOADED SUPERSET window when set, else the
  // global window. The superset is WIDER than the visible view, so the rows the chart
  // holds always extend past both view edges → panning stays over real data.
  const fetchFrom = load ? load.from : from;
  const fetchTo = load ? load.to : to;
  // WS8: the explicit `?bucket=` for the fetch — the VIEW's grain, so the wider
  // superset is aggregated at the resolution the view needs (grain coherence). Absent
  // when no overscan load is active (the route picks the bucket from the span).
  const fetchBucket = load ? load.bucketSecs : undefined;

  // Drop any active zoom (and any in-progress drag) whenever the fuel, the account,
  // or the GLOBAL range changes — a zoom into the old context would be stale. WS7:
  // also reset the live `view` to the new global bounds so the numeric axis domain
  // snaps to the fresh context (it's reconciled again when the fetch lands). WS8:
  // clear the loaded superset too so the next reconcile loads a fresh one.
  useEffect(() => {
    setZoom(null);
    setLoad(null);
    setDrag(null);
    setZoomHint(false);
    panDragRef.current = null;
    if (navTimerRef.current) {
      clearTimeout(navTimerRef.current);
      navTimerRef.current = null;
    }
  }, [fuel, from, to, accountId]);

  // WS7: keep the wheel listener's fresh-focus ref in lockstep with `focused`, so a
  // shift+wheel fired the instant the chart is clicked still preventDefault()s (the
  // stale closure that caused the page-scroll leak can't win against a ref read).
  useEffect(() => {
    focusedRef.current = focused;
  }, [focused]);

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

  // Auto-dismiss the "Max zoom reached" hint ~2s after it's shown (issue #141).
  useEffect(() => {
    if (!zoomHint) return;
    const id = setTimeout(() => setZoomHint(false), ZOOM_HINT_MS);
    return () => clearTimeout(id);
  }, [zoomHint]);

  // ---- WS5 focus management: Esc + click-away release -----------------------
  // While focused, listen on the document for: (1) Esc → blur; (2) a pointer-down
  // OUTSIDE the chart body → blur (click-away). Listening on the document (not the
  // wrapper's onBlur) is robust: the SVG/Recharts internals steal focus and a real
  // <div> blur never fires reliably here, so we drive focus explicitly. Only wired
  // up while focused, so it adds no global listeners at rest. (#150: the shared
  // useDismissable hook, with the DELIBERATE capture-phase + pointerdown options so
  // we see the click-away before any stopPropagation inside the chart.)
  useDismissable(bodyRef, focused, () => setFocused(false), {
    event: 'pointerdown',
    capture: true,
  });

  // Track Ctrl globally so the Ctrl+drag pan can detect the modifier even though the
  // Recharts synthetic mouse-state object doesn't expose it. Cheap, always-on (a
  // boolean flip); the gesture only reads ctrlDownRef while focused + dragging.
  //
  // WS6 EXTENSION: the same handler now also mirrors Ctrl AND Shift into the reactive
  // `ctrlDown`/`shiftDown` STATE that drives the modifier→cursor feedback (navCursor).
  // The gesture handlers keep reading ctrlDownRef (always fresh, no render needed);
  // the state copies exist purely so a press/release RE-RENDERS the cursor. Updated on
  // BOTH keydown and keyup so releasing a key restores the cursor. setState is a no-op
  // when the value is unchanged, so the held-key key-repeat doesn't thrash renders.
  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      ctrlDownRef.current = ctrl;
      setCtrlDown(ctrl);
      setShiftDown(shift);
    };
    // A window blur (alt-tab, focus loss) can swallow the keyup → the modifier would
    // appear stuck-down. Clear the reactive cursor state on blur to self-heal.
    const onBlur = () => {
      ctrlDownRef.current = false;
      setCtrlDown(false);
      setShiftDown(false);
    };
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Derive the chart cursor (WS6) from the focus + modifier + active-drag state via
  // the PURE navCursor resolver. Recomputed on every relevant state change; applied to
  // the LineChart's `style.cursor`. Not focused → 'default' (gestures inert).
  const chartCursor = navCursor({ focused, ctrlDown, shiftDown, ctrlDragging, hovering });

  // ---- WS8: the overscan reconcile -----------------------------------------
  // A FRESH mirror of `load` so the debounced reconcile reads the current superset
  // without re-arming on every `load` change (the reconcile runs after a gesture, by
  // which time React may not have committed the latest `load`). Kept in sync below.
  const loadRef = useRef<LoadWindow | null>(null);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

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

  // Clean up the debounce timer on unmount.
  useEffect(
    () => () => {
      if (navTimerRef.current) clearTimeout(navTimerRef.current);
    },
    [],
  );

  // The "base" reload key (fuel/global-range/account) is kept only so the fetch
  // effect can record what it last fetched. WS2's no-cold-blank rule no longer needs
  // a base-vs-zoom branch: we NEVER setState(undefined) once there's data on screen.
  const baseKeyRef = useRef<string | null>(null);

  // Fetch on mount + whenever the fuel, account, or the (possibly zoomed) window
  // changes. STALE-WHILE-REVALIDATE: paint the cached series for this exact key
  // instantly (if warm), then revalidate and swap in place. `alive` guards against
  // an out-of-order response overwriting a newer one.
  useEffect(() => {
    let alive = true;
    const acctQuery = accountId != null ? `&accountId=${accountId}` : '';
    // Follow the loaded OVERSCAN superset window when set (WS8), else the GLOBAL range;
    // otherwise let the route default to its trailing window (non-dashboard caller).
    const rangeQuery = fetchFrom && fetchTo ? `&from=${fetchFrom}&to=${fetchTo}` : '';
    // WS8: when an overscan load is active, pin the route to the VIEW's grain via
    // `?bucket=` so the wider superset is aggregated at the view's resolution (grain
    // coherence). Absent → the route picks the bucket from the span (pre-WS8 path).
    const bucketQuery = fetchBucket != null ? `&bucket=${fetchBucket}` : '';
    const url = `/api/interval?fuel=${fuel}${rangeQuery}${bucketQuery}${acctQuery}`;
    // The cache key keys off the FETCHED window + bucket (WS8) so an overscan superset
    // and a base view (or two buckets over the same window) are distinct cache
    // entries — each repaints its own last-seen series.
    const key = intervalCacheKey({ fuel, from: fetchFrom, to: fetchTo, accountId, bucket: fetchBucket });

    // NEVER COLD-BLANK. The single state change that makes this true:
    //   • warm cache for THIS key → hydrate state from cache NOW (instant repaint),
    //   • else if we ALREADY have data on screen (any prior Loaded) → keep it up,
    //   • else (genuine first load, nothing to show) → skeleton (state=undefined).
    // Then revalidate in the background and swap in place. We do NOT
    // setState(undefined) for a base reload anymore — that was the old cold-blank.
    const cached = getCached(key);
    setState((prev) => {
      if (cached) return toLoaded(cached); // warm → instant repaint of last-seen series
      if (prev && !('error' in prev)) return prev; // have data → keep it, shimmer over it
      return undefined; // genuine first load → the only cold (skeleton) state left
    });
    // Shimmer whenever we already have something to show (cache hit or prior data);
    // only the true first load (no cache, no prior data) suppresses it for the skeleton.
    setRevalidating(!!cached || (!!state && !('error' in state)));
    baseKeyRef.current = key;

    swrFetch(key, url)
      .then((resp) => {
        if (!alive) return;
        // WS8: swap the rows in WITHOUT any animation. The visible slice of the loaded
        // superset is the SAME data (the view domain is unchanged across an overscan
        // swap), so an instant swap is invisible for a pan and just sharpens-in-place
        // for a finer-grain zoom — no resize/morph. (The WS6 line-morph is removed.)
        setState(toLoaded(resp));
        setRevalidating(false);
      })
      .catch(() => {
        if (!alive) return;
        // On a hard failure keep any stale data we were showing (stale beats blank);
        // only show the error card if we have nothing at all.
        setRevalidating(false);
        setState((prev) => (prev && !('error' in prev) ? prev : { error: true }));
      });
    return () => {
      alive = false;
    };
    // `state` is read only to decide the shimmer flag at fetch START; including it in
    // deps would re-run the effect on every swap (an infinite loop). The fetch
    // identity is fully determined by fuel/window/bucket/account (WS8 adds bucket).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fuel, fetchFrom, fetchTo, fetchBucket, accountId]);

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

  // ---- WS5/WS7/WS9: native non-passive wheel listener (zoom / shift-pan) -----
  // React's onWheel is PASSIVE — it can't preventDefault to stop page scroll. So we
  // attach a native listener with { passive: false } on the chart body. Wheel up =
  // zoom IN, down = zoom OUT, centered on hoverTsRef (fallback: window midpoint);
  // Shift+wheel = pan. The window update is immediate (and so, via the derived `view`,
  // the line slides/scales LIVE); the refetch is debounced.
  //
  // WS9 GATING (capture the PAN on HOVER, keep ZOOM focus-gated). WS7 gated ALL
  // handling — including preventDefault — on `focusedRef.current`, so shift+scrolling
  // over the chart WITHOUT first clicking it leaked to the page (the operator
  // naturally shift+scrolls on hover). The pan gesture (shift+wheel) is now captured
  // whenever the cursor is over the chart, focused or not; the zoom gesture (plain
  // wheel) STAYS focus-gated so plain page-scrolling past an unfocused chart still
  // works (we don't trap it). Ctrl-without-shift while unfocused is left alone too:
  //   const isPan = e.shiftKey || horizontalWheel;      // shift OR horizontal wheel = pan
  //   if (!focusedRef.current && !isPan) return;        // unfocused, non-pan → leave
  //   e.preventDefault();                               // pan (any focus) / focused
  // The pan branch computes purely from `zoom`/bounds, so it works regardless of
  // focus. WS7's other guarantees stand: preventDefault fires BEFORE the no-data
  // early return (so the page can't scroll from a captured gesture even with no
  // rows), and focus is read from the always-fresh `focusedRef` (no stale-closure
  // race on the very first wheel after a click).
  //
  // We read BOTH deltaY AND deltaX: shift+wheel emits a HORIZONTAL delta on many
  // setups (the OS/browser maps shift+vertical-wheel to deltaX), so we pan by whichever
  // axis is non-zero (preferring the larger magnitude) and derive direction from its
  // sign — preventDefault covers both axes (it's the unconditional `e.preventDefault()`
  // on the captured path, not an axis-specific guard).
  //
  // The listener is bound for the lifetime of the chart body. It only fires for wheel
  // events delivered TO the body (i.e. the cursor is over it), so the hover condition
  // for the pan is implicit in the listener's target; we still gate the ZOOM on focus
  // explicitly so an unfocused hover-scroll passes through.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // WS9: the PAN (shift+wheel) is captured on hover, focused or not; the ZOOM
      // (plain wheel) needs focus. So: when unfocused AND this isn't a pan, leave the
      // event for the page (normal scroll). Otherwise we own it → preventDefault. Read
      // focus from the always-fresh ref (not the stale closure). Ctrl-without-shift on
      // an unfocused chart falls into the "leave it" branch — the browser handles it.
      // macOS and many trackpads convert shift+scroll into a HORIZONTAL wheel — deltaX
      // set, shiftKey=FALSE — so a `e.shiftKey`-only gate misses it and the page scrolls
      // (the leak the operator hit on their setup, even though shiftKey+deltaY works).
      // Recognise a pan by EITHER the shift key OR a predominantly-horizontal delta.
      const horizontalWheel = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const isPan = e.shiftKey || horizontalWheel;
      if (!focusedRef.current && !isPan) return;
      e.preventDefault();
      // STOP the event from bubbling to the cockpit paginator's ancestor wheel
      // listener (WidgetLayout's trackpad horizontal-scroll paging), which would
      // otherwise also act on this horizontal wheel and FLIP THE PAGE — sliding the
      // chart off-screen so a pan "works once then stops". preventDefault only
      // suppresses the browser's default scroll, NOT ancestor JS listeners; we own
      // this gesture, so stop propagation too.
      e.stopPropagation();
      // Past here the page is already prevented; the gesture math no-ops (returns)
      // when we can't compute a window — but the page stays put either way.
      if (!boundsValid || data.length === 0) return;
      ctrlDownRef.current = e.ctrlKey || e.metaKey; // keep Ctrl tracking fresh
      // WS11: read the CURRENT window from the FRESH committed mirror (`curWindowRef`),
      // NOT the captured `zoom` closure — the SAME ref WS10's Ctrl+drag uses. A burst of
      // wheel notches fires faster than React commits `setZoom` + re-binds this listener,
      // so the closure's `zoom` was STALE: each notch then panned from the SAME old
      // window, and a stale read that momentarily fell back to the full `boundsFromMs..
      // boundsToMs` made the span JUMP to the whole range — so repeated horizontal pans
      // DISTORTED the window (the right edge pinned ~now while the left ran far back: a
      // widen, not a clean slide). Reading the ref means each notch ACCUMULATES from where
      // the last one committed, with a CONSTANT span (panWindow preserves the span and
      // only clamps the SHIFT at the global edge). Mirrors WS10's curWindowRef fix.
      const cur = curWindowRef.current;
      const fromMs = cur.fromMs;
      const toMs = cur.toMs;
      if (isPan) {
        // Shift+wheel (or a horizontal wheel) → pan. Use whichever wheel axis carries
        // the delta. Many
        // setups report shift+wheel as deltaX; some still report deltaY — pick the
        // axis with the larger magnitude so a single source drives the pan. A positive
        // delta pans RIGHT (later time); negative pans LEFT.
        const raw = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (raw === 0) return; // nothing to pan (page already prevented)
        const span = toMs - fromMs;
        const dir = raw > 0 ? 1 : -1;
        const next = panWindow(
          fromMs,
          toMs,
          dir * WHEEL_PAN_FRACTION * span,
          boundsFromMs,
          boundsToMs,
        );
        applyNavWindow(next);
      } else {
        // Wheel up (deltaY < 0) → zoom IN; wheel down → zoom OUT. Center on the
        // hovered ts, falling back to the window midpoint when no hover is tracked.
        // WS7: fall back to deltaX when a setup reports the plain wheel horizontally.
        const raw = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        if (raw === 0) return; // no scroll magnitude → nothing to zoom
        const center =
          hoverTsRef.current != null && Number.isFinite(hoverTsRef.current)
            ? hoverTsRef.current
            : (fromMs + toMs) / 2;
        const factor = raw < 0 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR;
        const next = zoomWindowAroundCenter(
          fromMs,
          toMs,
          center,
          factor,
          boundsFromMs,
          boundsToMs,
          MIN_ZOOM_SPAN_MS,
        );
        applyNavWindow(next);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // WS11: `zoom` is no longer a dep — the handler reads the CURRENT window from the
    // fresh `curWindowRef.current` (a stable ref), so the listener no longer needs to
    // re-bind on every wheel-notch's `setZoom`. That removal is also what makes the pan
    // accumulate correctly: a stable handler reading a fresh ref can't read a stale
    // closure mid-burst. The remaining deps fully determine the gesture math.
  }, [boundsValid, boundsFromMs, boundsToMs, data.length, applyNavWindow]);

  // ---- WS10: native Ctrl+drag PAN (pixel-anchored) --------------------------
  // The Ctrl+drag pan is driven by the RAW PIXEL delta from the drag START — NOT the
  // nearest data point's ts under the (live-moving) numeric domain. The old version
  // computed `cursorDelta = pt.ts - pan.startTs` against the domain the pan itself was
  // moving, so the same screen pixel mapped to a different ts each move → the delta fed
  // back, the window oscillated/quantized (glitchy) and netted back toward the start
  // ("snapped back"). WS10 anchors everything to fixed START values, so there is NO
  // feedback loop: the same `deltaPx` always yields the same window, and the window
  // tracks the cursor 1:1 and STAYS on release.
  //
  // We need `e.clientX` + the plot pixel width, neither of which Recharts' synthetic
  // mouse-state exposes — so this is a NATIVE listener on the chart body (like the
  // wheel listener). On Ctrl+mousedown we capture the START window (from the fresh
  // `curWindowRef`), the START clientX, and the plot width (the body's measured width
  // minus the chart's non-plot horizontal insets). Each move: `deltaPx = clientX −
  // startClientX`; `deltaMs = -pixelPanDeltaMs(deltaPx, plotWidthPx, startSpanMs)` (the
  // NEGATION is the "grab the plot" direction — drag RIGHT → reveal EARLIER time →
  // window moves LEFT); then `panWindow(startFrom, startTo, deltaMs, …)` clamps to the
  // global bounds and `applyNavWindow` pushes it into the live `zoom` domain. mouseup
  // forces a synchronous overscan reconcile of the final window. The non-Ctrl path is
  // left entirely to Recharts (the plain zoom-SELECT band), so the two never conflict.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    const endPan = () => {
      const pan = panDragRef.current;
      if (!pan) return;
      panDragRef.current = null;
      setCtrlDragging(false); // WS6: pan ended → cursor back to 'grab' (Ctrl still held)
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Force a synchronous overscan reconcile of the FINAL window (the live `zoom`
      // already tracked the drag; this tops up the loaded superset for the rest spot).
      const w = curWindowRef.current;
      applyNavWindow({ fromMs: w.fromMs, toMs: w.toMs }, true);
    };

    const onMove = (e: MouseEvent) => {
      const pan = panDragRef.current;
      if (!pan) return;
      const deltaPx = e.clientX - pan.startClientX;
      const startSpan = pan.toMs - pan.fromMs;
      // "Grab the plot": drag right (deltaPx > 0) reveals EARLIER time → window LEFT,
      // hence the negation. Anchored to the START window + START pixel → no feedback.
      const deltaMs = -pixelPanDeltaMs(deltaPx, pan.plotWidthPx, startSpan);
      const next = panWindow(pan.fromMs, pan.toMs, deltaMs, boundsFromMs, boundsToMs);
      applyNavWindow(next); // live domain updates immediately; reconcile is debounced
    };

    const onUp = () => endPan();

    const onDown = (e: MouseEvent) => {
      // Only a PRIMARY-button Ctrl(/Cmd)+drag starts a pan; everything else (plain
      // drag, right-click) is left to Recharts' handlers (the zoom-SELECT band).
      if (e.button !== 0) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (!boundsValid) return;
      ctrlDownRef.current = true; // keep Ctrl tracking fresh
      // Plot pixel width = measured body width − the non-plot horizontal insets
      // (YAxis width + left/right margins). Guard against a zero/negative width.
      const rect = el.getBoundingClientRect();
      const plotWidthPx = rect.width - PLOT_X_INSET;
      if (!(plotWidthPx > 0)) return;
      const w = curWindowRef.current;
      panDragRef.current = {
        startClientX: e.clientX,
        fromMs: w.fromMs,
        toMs: w.toMs,
        plotWidthPx,
      };
      setCtrlDragging(true); // WS6: cursor → 'grabbing' while the pan is live
      // Suppress text-selection / Recharts' band for this gesture; track on the
      // DOCUMENT so a drag that leaves the chart body keeps panning until mouseup.
      e.preventDefault();
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    el.addEventListener('mousedown', onDown);
    return () => {
      el.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [boundsValid, boundsFromMs, boundsToMs, applyNavWindow]);

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
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
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
