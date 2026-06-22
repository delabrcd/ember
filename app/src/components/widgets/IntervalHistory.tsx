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
// fetch window (`fetchZoom`) is a debounced copy so rapid ticks don't spam the route.

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
import { toHistoryPoints, formatGrain, type HistoryPoint } from '@/lib/intervalHistory';
import {
  classifyZoomSelection,
  zoomSpanToRange,
  zoomWindowAroundCenter,
  panWindow,
  type WindowMs,
} from '@/lib/intervalZoom';
import {
  getCached,
  swrFetch,
  intervalCacheKey,
  type IntervalResponse,
} from '@/lib/intervalCache';
import { ChartShell } from '../ChartShell';

// ---- Theme constants (mirrors IntervalLoadShape) ----------------------------
const ELEC = '#f59e0b';
const GAS = '#38bdf8';
const tooltipStyle = {
  backgroundColor: '#0f172a',
  border: '1px solid #1e293b',
  borderRadius: 12,
  fontSize: 12,
} as const;
const axisStyle = { stroke: '#475569', fontSize: 11 } as const;

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

// An in-progress drag-select on the main chart: the activeLabel (XAxis category
// value) under the mouse-down and the current mouse position. Both are the
// `dataKey="label"` strings Recharts reports as `e.activeLabel`. While this is
// non-null and `refX2` differs from `refX1`, we draw the selection band.
type DragSel = { refX1: string; refX2: string | null };

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

// ---- Segmented toggle -------------------------------------------------------
// A reusable generic segmented control (mirrors the toggle in IntervalLoadShape).
function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1 text-xs transition ${
            value === opt.value
              ? 'bg-amber-500 text-slate-950'
              : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
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
  // The DEBOUNCED copy of `zoom` that actually drives the fetch (WS5). Gestures
  // update `zoom` immediately (responsive subtitle/reset affordance) but only push
  // into `fetchZoom` after NAV_REFETCH_DEBOUNCE_MS so a flurry of ticks → one fetch.
  // The drag-select commit and resetZoom set it synchronously (no debounce) so a
  // discrete gesture refetches at once. null ⇒ follow the global window.
  const [fetchZoom, setFetchZoom] = useState<Zoom | null>(null);

  // The chart-body wrapper element — the focus host. We attach the native
  // non-passive wheel listener here and draw the focus ring on it.
  const bodyRef = useRef<HTMLDivElement | null>(null);
  // The time (epoch-ms) under the cursor, tracked from the Recharts onMouseMove via
  // pointByLabel. The wheel handler uses it as the zoom center (fallback: midpoint).
  const hoverTsRef = useRef<number | null>(null);
  // Whether Ctrl is currently held — tracked from document keydown/keyup AND from the
  // native mouse/wheel events, because Recharts' synthetic mouse-state object doesn't
  // reliably expose modifier keys. Drives the Ctrl+drag pan branch.
  const ctrlDownRef = useRef(false);
  // The in-flight Ctrl+drag pan, if any: the hover ts + window captured at mouse-down.
  // While set, plain drag-select is suppressed and moves pan the window instead.
  const panDragRef = useRef<{ startTs: number; fromMs: number; toMs: number } | null>(null);
  // The debounce timer handle for the gesture refetch.
  const navTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The window actually fetched: the DEBOUNCED zoom span when zoomed, else global.
  const fetchFrom = fetchZoom ? fetchZoom.from : from;
  const fetchTo = fetchZoom ? fetchZoom.to : to;

  // Drop any active zoom (and any in-progress drag) whenever the fuel, the account,
  // or the GLOBAL range changes — a zoom into the old context would be stale.
  useEffect(() => {
    setZoom(null);
    setFetchZoom(null);
    setDrag(null);
    setZoomHint(false);
    panDragRef.current = null;
    if (navTimerRef.current) {
      clearTimeout(navTimerRef.current);
      navTimerRef.current = null;
    }
  }, [fuel, from, to, accountId]);

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
  // up while focused, so it adds no global listeners at rest.
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFocused(false);
    };
    const onDocPointer = (e: PointerEvent) => {
      const el = bodyRef.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) setFocused(false);
    };
    document.addEventListener('keydown', onKey);
    // Capture phase so we see the click-away before any stopPropagation inside it.
    document.addEventListener('pointerdown', onDocPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDocPointer, true);
    };
  }, [focused]);

  // Track Ctrl globally so the Ctrl+drag pan can detect the modifier even though the
  // Recharts synthetic mouse-state object doesn't expose it. Cheap, always-on (a
  // boolean flip); the gesture only reads ctrlDownRef while focused + dragging.
  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      ctrlDownRef.current = e.ctrlKey || e.metaKey;
    };
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
    };
  }, []);

  // Push the current display window (`zoom`) into the DEBOUNCED fetch window after
  // NAV_REFETCH_DEBOUNCE_MS — a flurry of wheel/pan ticks coalesces into one
  // /api/interval request. `null` clears the fetch zoom (back to the global window).
  const scheduleNavRefetch = useCallback((next: Zoom | null) => {
    if (navTimerRef.current) clearTimeout(navTimerRef.current);
    navTimerRef.current = setTimeout(() => {
      navTimerRef.current = null;
      setFetchZoom(next);
    }, NAV_REFETCH_DEBOUNCE_MS);
  }, []);

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
    // Follow the zoomed span when zoomed, else the GLOBAL range; otherwise let the
    // route default to its trailing window (non-dashboard caller). The client no
    // longer sends `grain` — WS1's server picks the bucket from the window span.
    const rangeQuery = fetchFrom && fetchTo ? `&from=${fetchFrom}&to=${fetchTo}` : '';
    const url = `/api/interval?fuel=${fuel}${rangeQuery}${acctQuery}`;
    // The cache key keys off the FETCHED window (fetchFrom/fetchTo) so a zoom and a
    // base view are distinct cache entries — each repaints its own last-seen series.
    const key = intervalCacheKey({ fuel, from: fetchFrom, to: fetchTo, accountId });

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
    // identity is fully determined by fuel/window/account.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fuel, fetchFrom, fetchTo, accountId]);

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

  // "End of 15-min data" marker (WS2). Resolve the categorical x-position (a `label`)
  // to draw the <ReferenceLine> at: the FIRST rendered point at/after fifteenMinFrom.
  // The X axis is categorical (dataKey="label"), so a ReferenceLine needs an x that
  // matches an actual label — not a raw timestamp. We only show it when:
  //   • fuel is ELECTRIC (there is no 15-min GAS data), AND
  //   • fifteenMinFrom is non-null, AND
  //   • fifteenMinFrom falls WITHIN the visible window (after the first point, before
  //     the last) so it isn't pinned to an axis edge for a window entirely
  //     before/after the 15-min band.
  // Out-of-window / null / Gas → null → no marker.
  const fifteenMinMarkerLabel: string | null = useMemo(() => {
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
    // Snap to the first rendered point at/after fifteenMinFrom (data is ascending).
    const pt = data.find((p) => p.ts >= fmTs);
    return pt ? pt.label : null;
  }, [fuel, state, data]);

  // Look up a rendered point's ts (epoch-ms) + index by its XAxis label. The drag
  // handlers receive `e.activeLabel` (the category value, i.e. our `label`); we map
  // it back to the underlying point. A Map keeps the lookup O(1) per move event.
  const pointByLabel = useMemo(() => {
    const m = new Map<string, { ts: number; index: number }>();
    data.forEach((p, i) => {
      if (!m.has(p.label)) m.set(p.label, { ts: p.ts, index: i });
    });
    return m;
  }, [data]);

  // The CURRENT window in epoch-ms: the live zoom span when zoomed, else the global
  // bounds. This is the window every WS5 gesture transforms (zoom/pan) before
  // re-clamping to the bounds. (`zoom` carries startMs/endMs; the global window is
  // boundsFromMs..boundsToMs.)
  const curFromMs = zoom ? zoom.startMs : boundsFromMs;
  const curToMs = zoom ? zoom.endMs : boundsToMs;

  // ---- WS5: apply a gesture-produced ms window ------------------------------
  // Clamp the new [fromMs,toMs] to the global bounds + min span, then:
  //   • if it reaches/exceeds the FULL global window → CLEAR the zoom (== Reset, the
  //     "Reset zoom" affordance hides) and refetch the global window;
  //   • else → set the LIVE zoom immediately (responsive subtitle/affordance) and
  //     DEBOUNCE the refetch so a flurry of ticks coalesces into one request.
  // `fetchZoomNow` forces a synchronous fetch (used by discrete gestures like the
  // drag-select commit / reset, where there's no flurry to coalesce).
  const applyNavWindow = useCallback(
    (next: WindowMs, fetchZoomNow = false) => {
      if (!boundsValid) return;
      const lo = next.fromMs;
      const hi = next.toMs;
      // Reached the full global window (within a 1s slop) → equivalent to Reset.
      if (lo <= boundsFromMs + 1000 && hi >= boundsToMs - 1000) {
        setDrag(null);
        setZoom(null);
        if (fetchZoomNow) {
          if (navTimerRef.current) {
            clearTimeout(navTimerRef.current);
            navTimerRef.current = null;
          }
          setFetchZoom(null);
        } else {
          scheduleNavRefetch(null);
        }
        return;
      }
      const { from: zf, to: zt } = zoomSpanToRange(lo, hi);
      const z: Zoom = { from: zf, to: zt, startMs: lo, endMs: hi };
      setZoom((prev) =>
        prev && prev.startMs === lo && prev.endMs === hi ? prev : z,
      );
      if (fetchZoomNow) {
        if (navTimerRef.current) {
          clearTimeout(navTimerRef.current);
          navTimerRef.current = null;
        }
        setFetchZoom(z);
      } else {
        scheduleNavRefetch(z);
      }
    },
    [boundsValid, boundsFromMs, boundsToMs, scheduleNavRefetch],
  );

  // ---- Drag handlers (issue #141 zoom-select + WS5 Ctrl+drag pan) -----------
  // Mouse-down focuses the chart (WS5) and starts either a Ctrl+drag PAN (record the
  // start hover ts + the current window) or the existing zoom-SELECT band (no Ctrl).
  const onChartMouseDown = useCallback(
    (e: { activeLabel?: string | number } | null) => {
      setFocused(true);
      const label = e?.activeLabel;
      if (label == null) return;
      if (ctrlDownRef.current && boundsValid) {
        // Ctrl+drag PAN: capture the start point's ts + the window we're panning.
        const a = pointByLabel.get(String(label));
        const startTs = a ? a.ts : hoverTsRef.current;
        if (startTs != null && Number.isFinite(startTs)) {
          panDragRef.current = { startTs, fromMs: curFromMs, toMs: curToMs };
          return; // suppress the zoom-select band while panning
        }
      }
      // Plain drag → the existing zoom-select band (UNCHANGED).
      setDrag({ refX1: String(label), refX2: null });
    },
    [boundsValid, pointByLabel, curFromMs, curToMs],
  );

  const onChartMouseMove = useCallback(
    (e: { activeLabel?: string | number } | null) => {
      const label = e?.activeLabel;
      // Always track the time under the cursor for the wheel-zoom center (WS5).
      if (label != null) {
        const pt = pointByLabel.get(String(label));
        if (pt) hoverTsRef.current = pt.ts;
      }
      // Ctrl+drag PAN in progress (WS5): pan the captured window by the TIME delta
      // between the start point and the current point (the window moves OPPOSITE the
      // cursor — grabbing the plot drags the data, so dragging right reveals EARLIER
      // time → shift the window left).
      const pan = panDragRef.current;
      if (pan) {
        if (label == null) return;
        const cur = pointByLabel.get(String(label));
        if (!cur) return;
        const cursorDelta = cur.ts - pan.startTs;
        const next = panWindow(pan.fromMs, pan.toMs, -cursorDelta, boundsFromMs, boundsToMs);
        applyNavWindow(next); // debounced refetch; live window updates immediately
        return;
      }
      // Plain zoom-SELECT band (issue #141, UNCHANGED).
      if (!drag) return;
      if (label == null) return;
      const next = String(label);
      setDrag((prev) => (prev && prev.refX2 !== next ? { ...prev, refX2: next } : prev));
    },
    [drag, pointByLabel, boundsFromMs, boundsToMs, applyNavWindow],
  );

  const commitDrag = useCallback(() => {
    // End a Ctrl+drag pan first (WS5): the live window already tracked the drag; just
    // force a synchronous refetch of the final window and clear the pan state.
    if (panDragRef.current) {
      panDragRef.current = null;
      if (zoom) applyNavWindow({ fromMs: zoom.startMs, toMs: zoom.endMs }, true);
      else applyNavWindow({ fromMs: boundsFromMs, toMs: boundsToMs }, true);
      return;
    }
    setDrag((sel) => {
      // Three cases (issue #141), decided by the PURE classifyZoomSelection:
      //   • 'click'     — silent no-op (no zoom, no hint).
      //   • 'too-small' — a deliberate drag below the floor → refuse + show hint.
      //   • 'zoom'      — productive drag → commit the zoom + refetch.
      if (!sel || sel.refX2 == null) return null;
      const a = pointByLabel.get(sel.refX1);
      const b = pointByLabel.get(sel.refX2);
      if (!a || !b || sel.refX2 === sel.refX1) return null;
      const kind = classifyZoomSelection(a.index, b.index, a.ts, b.ts, MIN_ZOOM_SPAN_MS);
      if (kind === 'click') return null;
      if (kind === 'too-small') {
        setZoomHint(true);
        return null;
      }
      const { from: zf, to: zt } = zoomSpanToRange(a.ts, b.ts);
      const startMs = Math.min(a.ts, b.ts);
      const endMs = Math.max(a.ts, b.ts);
      const z: Zoom = { from: zf, to: zt, startMs, endMs };
      setZoom((prev) => (prev && prev.from === zf && prev.to === zt ? prev : z));
      // Discrete gesture → fetch synchronously (no flurry to debounce).
      if (navTimerRef.current) {
        clearTimeout(navTimerRef.current);
        navTimerRef.current = null;
      }
      setFetchZoom(z);
      return null;
    });
  }, [pointByLabel, zoom, boundsFromMs, boundsToMs, applyNavWindow]);

  const resetZoom = useCallback(() => {
    setDrag(null);
    setZoom(null);
    panDragRef.current = null;
    if (navTimerRef.current) {
      clearTimeout(navTimerRef.current);
      navTimerRef.current = null;
    }
    setFetchZoom(null);
  }, []);

  // ---- WS5: native non-passive wheel listener (zoom / shift-pan) ------------
  // React's onWheel is PASSIVE — it can't preventDefault to stop page scroll. So we
  // attach a native listener with { passive: false } on the chart body, gated on
  // `focused`: it's only present (and only captures scroll) while the chart is
  // focused, so scrolling past an UNfocused chart is never trapped. Wheel up = zoom
  // IN, down = zoom OUT, centered on hoverTsRef (fallback: window midpoint);
  // Shift+wheel = pan. The window update is immediate; the refetch is debounced.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !focused) return;
    const onWheel = (e: WheelEvent) => {
      // No-op (and let the page scroll) when we can't compute a window.
      if (!boundsValid || data.length === 0) return;
      e.preventDefault(); // capture: don't scroll the page while navigating
      ctrlDownRef.current = e.ctrlKey || e.metaKey; // keep Ctrl tracking fresh
      const fromMs = zoom ? zoom.startMs : boundsFromMs;
      const toMs = zoom ? zoom.endMs : boundsToMs;
      if (e.shiftKey) {
        // Shift+wheel → pan. deltaY > 0 (wheel down) pans RIGHT (later); < 0 LEFT.
        const span = toMs - fromMs;
        const dir = e.deltaY > 0 ? 1 : -1;
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
        const center =
          hoverTsRef.current != null && Number.isFinite(hoverTsRef.current)
            ? hoverTsRef.current
            : (fromMs + toMs) / 2;
        const factor = e.deltaY < 0 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR;
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
  }, [focused, boundsValid, boundsFromMs, boundsToMs, zoom, data.length, applyNavWindow]);

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
            margin={{ top: 5, right: 10, left: 0, bottom: 0 }}
            onMouseDown={onChartMouseDown}
            onMouseMove={onChartMouseMove}
            onMouseUp={commitDrag}
            onMouseLeave={commitDrag}
            style={{ cursor: 'crosshair', userSelect: 'none' }}
          >
            <CartesianGrid stroke="#1e293b" vertical={false} />
            <XAxis
              dataKey="label"
              {...axisStyle}
              minTickGap={40}
              interval="preserveStartEnd"
            />
            <YAxis
              {...axisStyle}
              width={42}
              // One precision now (server-chosen grain). 2 decimals reads well for
              // both the small 15-min kWh values and the larger coarse-bucket sums.
              tickFormatter={(v: number) => Number(v).toFixed(2)}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={tooltipFormatter}
              labelFormatter={(l) => `${l}`}
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
              isAnimationActive={false}
              connectNulls={false}
            />
            {/* "End of 15-min data" marker (WS2): a vertical reference line at the
                first point where true 15-min detail begins (electric only, and only
                when that boundary falls inside the visible window). Drawn AFTER the
                Line so it sits on top; the label points right ("15-min data →")
                toward the finer-resolution side. */}
            {fifteenMinMarkerLabel != null && (
              <ReferenceLine
                x={fifteenMinMarkerLabel}
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
            {/* The in-progress drag-selection band (issue #141). */}
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
