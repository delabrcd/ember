'use client';

// The interval HISTORY widget (issue #121 part 2): a self-contained dashboard
// tile showing the RAW historical smart-meter reads over time. Unlike the
// load-shape widget (which shows an AVERAGE DAY profile), this widget plots
// the actual timeline so the user can see usage trends, daily patterns, and
// gaps in the data.
//
// SELF-FETCHING (deliberately contained): like IntervalLoadShape, this widget
// owns its own data. On mount (and whenever a control or the selected account
// changes) it fetches /api/interval, optionally shapes the rows via
// reconcileToHourly, and draws the result with Recharts. It does NOT touch the
// ChartSpec/ConfigurableChart seam.
//
// CONTROLS:
//   • Resolution: 1h | 15m
//     - 1h  → reconcileToHourly(rows) (best hourly value, 15-min-summed where
//             available, else the hourly row).
//     - 15m → rows.filter(r => r.intervalSeconds === 900) (raw 15-min reads).
//             Disabled / falls back to 1h for Gas (no 15-min gas data).
//   • Fuel: Electric | Gas
//
// RANGE (issue #36): the widget no longer owns its time window — it follows the
// GLOBAL RangeControl, receiving the resolved `from`/`to` ISO day bounds as props
// (the same range every monthly chart uses) and fetching /api/interval?from=…&to=….
// A wide range (e.g. "All") is downsampled SERVER-SIDE (bucket-mean, ≤ MAX_POINTS)
// so the chart stays smooth; the 15m resolution still only has the recent ~48h of
// detail the API serves (older spans render at the hourly grain).
//
// ZOOM (issue #141): on TOP of the global range, the user can narrow into a
// sub-span LOCALLY by DRAG-SELECTING a band across the chart (the classic
// stock-chart gesture) without mutating the global RangeControl. We listen to the
// Recharts LineChart mouse handlers: onMouseDown records the start x, onMouseMove
// (while dragging) updates the current x, onMouseUp commits. The in-progress band
// is drawn with a <ReferenceArea>. On commit, the two selected x positions map to
// their data points' ts and become the zoom window; we refetch /api/interval for
// just that span (finer, less server-downsampled detail).
//
// WHY DRAG-SELECT, NOT A BRUSH: the previous design used a Recharts <Brush> whose
// handle sub-selects the loaded data. When a narrow drag refetched finer data, the
// new data WAS that span, so the handle had nothing left to sub-select and reset
// to full width — the user saw the chart "snap back to the start" (intermittently,
// "every other drag"). A drag-select gesture has no persistent handle, so there is
// nothing that can snap: each drag simply commits a new zoom and refetches.
//
// The refetch swaps the rows IN PLACE — it never blanks the chart to the loading
// skeleton (only the fuel/account/global-range load does that). Dragging again on
// the zoomed chart zooms FURTHER (refetch for the new, narrower span). A "Reset
// zoom" affordance returns to the global window. The zoom is per-widget ephemeral
// state (lib/intervalZoom.ts holds the pure span/selection math).
//
// CLICK vs DRAG vs TOO-SMALL (issue #141): classifyZoomSelection sorts a gesture
// into three outcomes. A pure click (mouse-down + up on one data point — same
// index) stays SILENT (no zoom, no hint). A deliberate drag (distinct points) whose
// span is below the hard floor MIN_ZOOM_SPAN_MS is REFUSED and flashes a transient
// "Max zoom reached" hint (~2s) so it isn't a silent no-op. A productive drag (span
// ≥ floor) zooms as before.
//
// INDICATORS (issue #141): on top of the zoom interaction, two at-a-glance cues —
//   • a PERSISTENT "Max zoom · finest detail" badge whenever /api/interval reports
//     it did NOT downsample (the response's `downsampled:false`), meaning the chart
//     is already at its native resolution. Correct zoomed or not.
//   • the TRANSIENT "Max zoom reached" hint above for a refused too-tight drag.
// Both can be true together (you're at finest detail AND you tried to zoom tighter).
//
// GAPS: the chart uses connectNulls={false} so real gaps in the data (missing
// intervals — the API omits them) render as line breaks, NEVER as fabricated
// zeros. This holds through zoom + refetch (the refetch path runs the same
// toHistoryPoints shaper, which drops gaps).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { reconcileToHourly, type IntervalProfileRow } from '@/lib/intervalProfile';
import { toHistoryPoints, type HistoryPoint } from '@/lib/intervalHistory';
import { classifyZoomSelection, zoomSpanToRange } from '@/lib/intervalZoom';
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
// Hard minimum zoom window (issue #141). A deliberate drag whose span is below
// this floor is REFUSED (no zoom) and surfaces the "Max zoom reached" hint instead
// of silently doing nothing. 1 hour is the floor because the finest grain the data
// ever reaches is 15-min electric (older spans are hourly): an hour-wide window
// already shows the densest data the chart can hold (~4 points at 15m, 1 at 1h), so
// drawing a tighter band can't reveal anything new — it's the natural "you've hit
// max zoom" boundary. (A pure click — both endpoints on one point — is handled
// separately by classifyZoomSelection and stays silent.)
const MIN_ZOOM_SPAN_MS = 60 * 60_000;

// How long the transient "Max zoom reached" hint stays up before auto-clearing.
const ZOOM_HINT_MS = 2_000;

// ---- Types ------------------------------------------------------------------
type Fuel = 'ELECTRIC' | 'GAS';
type Resolution = '1h' | '15m';

const FUELS: readonly Fuel[] = ['ELECTRIC', 'GAS'];
const FUEL_LABEL: Record<Fuel, string> = { ELECTRIC: 'Electric', GAS: 'Gas' };
const FUEL_UNIT: Record<Fuel, string> = { ELECTRIC: 'kWh', GAS: 'therms' };

// The /api/interval payload rows (fuelType + unit from the API, plus the
// IntervalProfileRow fields the shapers need).
type IntervalApiRow = IntervalProfileRow & { fuelType?: string; unit?: string };

// `downsampled` (issue #141): whether /api/interval reduced the set, i.e. whether
// FINER detail than what's shown exists. false → the chart is at native resolution
// → show the "Max zoom · finest detail" badge.
type LoadState = { rows: IntervalApiRow[]; downsampled: boolean } | { error: true } | undefined;

// A locally-zoomed window: the day bounds we refetched for finer detail, plus the
// raw ms span the user selected (so the reset/label can describe it). Ephemeral
// per-widget state — it never touches the global RangeControl.
type Zoom = { from: string; to: string; startMs: number; endMs: number };

// An in-progress drag-select on the main chart: the activeLabel (XAxis category
// value) under the mouse-down and the current mouse position. Both are the
// `dataKey="label"` strings Recharts reports as `e.activeLabel`. While this is
// non-null and `refX2` differs from `refX1`, we draw the selection band.
type DragSel = { refX1: string; refX2: string | null };

// ---- Segmented toggle -------------------------------------------------------
// A reusable generic segmented control (mirrors the toggle in IntervalLoadShape).
function Segmented<T extends string>({
  options,
  value,
  onChange,
  disabledValues,
}: {
  options: { label: string; value: T }[];
  value: T;
  onChange: (v: T) => void;
  disabledValues?: Set<T>;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
      {options.map((opt) => {
        const disabled = disabledValues?.has(opt.value) ?? false;
        return (
          <button
            key={opt.value}
            onClick={() => !disabled && onChange(opt.value)}
            disabled={disabled}
            className={`px-2.5 py-1 text-xs transition ${
              value === opt.value
                ? 'bg-amber-500 text-slate-950'
                : disabled
                  ? 'cursor-not-allowed bg-slate-800/50 text-slate-600'
                  : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ---- Settings panel ---------------------------------------------------------
// Rendered inside ChartShell's Customize popover / expand side. Mirrors
// ChartConfigMenu's row layout (uppercase label + a segmented control): Fuel and
// Resolution (1h/15m, 15m disabled for gas). The time window is GLOBAL (issue
// #36 — driven by the dashboard RangeControl), so there's no per-widget range row.
function HistorySettings({
  fuel,
  onFuel,
  resolution,
  onResolution,
  resolutionDisabled,
}: {
  fuel: Fuel;
  onFuel: (f: Fuel) => void;
  resolution: Resolution;
  onResolution: (r: Resolution) => void;
  resolutionDisabled: boolean;
}) {
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
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Resolution</div>
        <Segmented
          options={[
            { label: '1h', value: '1h' as Resolution },
            { label: '15m', value: '15m' as Resolution },
          ]}
          value={resolution}
          onChange={onResolution}
          disabledValues={resolutionDisabled ? new Set<Resolution>(['15m']) : undefined}
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
  const [resolution, setResolution] = useState<Resolution>('1h');
  const [state, setState] = useState<LoadState>(undefined);
  // The locally-zoomed window (issue #141). When set, the widget has refetched
  // /api/interval for [zoom.from, zoom.to] (finer detail) and renders that span.
  const [zoom, setZoom] = useState<Zoom | null>(null);
  // The in-progress drag-selection (issue #141). Non-null between onMouseDown and
  // onMouseUp; drives the <ReferenceArea> band. Committed (or discarded) on mouse
  // up, then cleared.
  const [drag, setDrag] = useState<DragSel | null>(null);
  // A brief, auto-dismissing "Max zoom reached" hint (issue #141), shown when a
  // deliberate drag is refused for being tighter than MIN_ZOOM_SPAN_MS. Cleared on
  // a timer (and on any base reload via the effect below).
  const [zoomHint, setZoomHint] = useState(false);

  // Gas has no 15-min data → disable the 15m option when fuel=Gas.
  // If the user switches to Gas while on 15m, fall back to 1h.
  const resolutionDisabled = fuel === 'GAS';
  const effectiveResolution: Resolution = resolutionDisabled ? '1h' : resolution;

  // When switching to Gas while 15m is selected, silently fall back to 1h in the
  // display as well (the effectiveResolution above governs shaping; this updates
  // the control so it doesn't show 15m selected but visually greyed out the same
  // slot that IS selected — confusing).
  useEffect(() => {
    if (fuel === 'GAS' && resolution === '15m') {
      setResolution('1h');
    }
  }, [fuel, resolution]);

  // The window actually fetched: the zoomed span when zoomed, else the global one.
  const fetchFrom = zoom ? zoom.from : from;
  const fetchTo = zoom ? zoom.to : to;

  // Drop any active zoom (and any in-progress drag) whenever the fuel, the
  // account, or the GLOBAL range changes — a zoom into the old context would be
  // stale (the reset is then a no-op the next fetch already reflects). Resolution
  // does NOT clear the zoom (the user may be zooming specifically to inspect 15m
  // detail); we just abandon any in-progress drag so a stale band can't commit
  // against the new grain.
  useEffect(() => {
    setZoom(null);
    setDrag(null);
    setZoomHint(false);
  }, [fuel, from, to, accountId]);
  useEffect(() => {
    setDrag(null);
  }, [effectiveResolution]);

  // Auto-dismiss the "Max zoom reached" hint ~2s after it's shown (issue #141), so
  // the refused-drag feedback is transient and never lingers.
  useEffect(() => {
    if (!zoomHint) return;
    const id = setTimeout(() => setZoomHint(false), ZOOM_HINT_MS);
    return () => clearTimeout(id);
  }, [zoomHint]);

  // To decide whether a given fetch should show the loading skeleton, we track
  // the "base" reload key (fuel/global-range/account). When ONLY the zoom-derived
  // window changed (a finer-detail refetch), the base key is unchanged → we keep
  // the current chart visible and swap data in place; we only blank to the
  // skeleton for a true base reload (mount, fuel/account/global-range change).
  const baseKeyRef = useRef<string | null>(null);

  // Fetch on mount + whenever controls, account, or the (possibly zoomed) window
  // change. Track an `alive` flag so a stale response (the user changed a control
  // mid-flight) can't overwrite the current one.
  useEffect(() => {
    let alive = true;
    const baseKey = `${fuel}|${from ?? ''}|${to ?? ''}|${accountId ?? ''}`;
    const isBaseReload = baseKeyRef.current !== baseKey;
    baseKeyRef.current = baseKey;
    // Skeleton only for a base reload; a zoom refetch keeps the prior chart up
    // (issue #141: no blank/loading flash while zooming).
    if (isBaseReload) setState(undefined);
    const acctQuery = accountId != null ? `&accountId=${accountId}` : '';
    // Follow the zoomed span when zoomed, else the GLOBAL range; otherwise let the
    // route default to its trailing window (non-dashboard caller). Server-side
    // downsampling keeps the returned series bounded (≤ MAX_POINTS) no matter how
    // wide the window is — but a narrow zoom span fits under the cap, so it comes
    // back at (or near) the finest available grain.
    const rangeQuery = fetchFrom && fetchTo ? `&from=${fetchFrom}&to=${fetchTo}` : '';
    // At 15m, ask the route for the RAW 900s rows (un-decimated). 15-min data is
    // recent/bounded so this is cheap, and it stops the server time-bucket
    // downsampler from collapsing the recent 15-min sliver to a handful of points
    // over a wide range (the bug: the chart looked empty until you zoomed in). The
    // 1h path stays on the default (all-grain, downsampled) feed.
    const grainQuery = effectiveResolution === '15m' ? '&grain=15m' : '';
    fetch(`/api/interval?fuel=${fuel}${rangeQuery}${grainQuery}${acctQuery}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        setState({
          rows: Array.isArray(j?.rows) ? (j.rows as IntervalApiRow[]) : [],
          // `downsampled` drives the "finest detail" badge (issue #141). Default to
          // false (badge shown) when the flag is absent — a missing flag means no
          // reduction was reported, i.e. treat the data as native-resolution.
          downsampled: j?.downsampled === true,
        });
      })
      .catch(() => {
        if (alive) setState({ error: true });
      });
    return () => {
      alive = false;
    };
  }, [fuel, fetchFrom, fetchTo, accountId, from, to, effectiveResolution]);

  const color = fuel === 'GAS' ? GAS : ELEC;
  const unit = FUEL_UNIT[fuel];

  // Shape the raw rows into chart points. For 1h: run through reconcileToHourly
  // first (best hourly value, 15-min-summed where available), then toHistoryPoints.
  // For 15m: filter to intervalSeconds=900 only, then toHistoryPoints.
  // Missing rows = missing points (no zeros fabricated — connectNulls=false means
  // gaps render as line breaks in the chart, the correct behavior).
  const data: HistoryPoint[] = useMemo(() => {
    if (!state || 'error' in state) return [];
    if (effectiveResolution === '1h') {
      return toHistoryPoints(reconcileToHourly(state.rows));
    } else {
      // 15m: raw 15-min electric reads only
      const rows15 = state.rows.filter((r) => r.intervalSeconds === 900);
      return toHistoryPoints(rows15);
    }
  }, [state, effectiveResolution]);

  const loading = state === undefined;
  const errored = !!state && 'error' in state;
  const empty = !loading && !errored && data.length === 0;

  // "Max zoom · finest detail" badge (issue #141): true when the route did NOT
  // downsample — the chart is at its native resolution and zooming further reveals
  // nothing new. Correct whether or not the user has zoomed (a naturally-small
  // global range that wasn't reduced shows it too). Suppressed while loading/errored
  // or with no data to qualify.
  const atFinestDetail =
    !!state && !('error' in state) && !state.downsampled && data.length > 0;

  // Look up a rendered point's ts (epoch-ms) + index by its XAxis label. The drag
  // handlers receive `e.activeLabel` (the category value, i.e. our `label`); we map
  // it back to the underlying point. A Map keeps the lookup O(1) per move event.
  const pointByLabel = useMemo(() => {
    const m = new Map<string, { ts: number; index: number }>();
    data.forEach((p, i) => {
      // Labels are unique per point in practice (distinct minute timestamps); if a
      // duplicate ever occurs the first wins, which is fine for span endpoints.
      if (!m.has(p.label)) m.set(p.label, { ts: p.ts, index: i });
    });
    return m;
  }, [data]);

  // ---- Drag-to-select-zoom handlers (issue #141) ----------------------------
  // Recharts reports the category under the cursor as `e.activeLabel`. We record
  // it on mouse-down, track it on mouse-move while a drag is active, and on
  // mouse-up map the two labels to their points' ts and (if the selection is
  // deliberate) commit a zoom that refetches the finer span.
  const onChartMouseDown = useCallback((e: { activeLabel?: string | number } | null) => {
    const label = e?.activeLabel;
    if (label == null) return;
    setDrag({ refX1: String(label), refX2: null });
  }, []);

  const onChartMouseMove = useCallback(
    (e: { activeLabel?: string | number } | null) => {
      // Only track while a drag is in progress (mouse-down happened on the chart).
      if (!drag) return;
      const label = e?.activeLabel;
      if (label == null) return;
      const next = String(label);
      setDrag((prev) => (prev && prev.refX2 !== next ? { ...prev, refX2: next } : prev));
    },
    [drag],
  );

  const commitDrag = useCallback(() => {
    setDrag((sel) => {
      // Always clear the band on mouse-up/leave. Beyond that we have three cases
      // (issue #141), decided by the PURE classifyZoomSelection:
      //   • 'click'     — silent no-op (no zoom, no hint).
      //   • 'too-small' — a deliberate drag below the floor → refuse + show hint.
      //   • 'zoom'      — productive drag → commit the zoom + refetch.
      if (!sel || sel.refX2 == null) return null;
      const a = pointByLabel.get(sel.refX1);
      const b = pointByLabel.get(sel.refX2);
      // A missing endpoint or both endpoints on the same label is a click.
      if (!a || !b || sel.refX2 === sel.refX1) return null;
      const kind = classifyZoomSelection(a.index, b.index, a.ts, b.ts, MIN_ZOOM_SPAN_MS);
      if (kind === 'click') return null;
      if (kind === 'too-small') {
        // Deliberate drag tighter than the floor: surface the transient hint so the
        // drag isn't a silent no-op, but do NOT zoom.
        setZoomHint(true);
        return null;
      }
      const { from: zf, to: zt } = zoomSpanToRange(a.ts, b.ts);
      const startMs = Math.min(a.ts, b.ts);
      const endMs = Math.max(a.ts, b.ts);
      // Commit the zoom (the fetch effect picks up the new fetchFrom/fetchTo and
      // refetches in place). Skip a redundant set if we're already on that span.
      setZoom((prev) => (prev && prev.from === zf && prev.to === zt ? prev : { from: zf, to: zt, startMs, endMs }));
      return null;
    });
  }, [pointByLabel]);

  const resetZoom = useCallback(() => {
    setDrag(null);
    setZoom(null);
  }, []);

  // Subtitle: e.g. "Electric · kWh · 1h" (the global time window is shown in the
  // dashboard header). When zoomed, append the local span so it's clear the chart
  // is showing a narrowed, finer-detail view.
  const subtitle = `${FUEL_LABEL[fuel]} · ${unit} · ${effectiveResolution}${
    zoom ? ` · zoomed ${zoom.from} → ${zoom.to}` : ''
  }`;

  // Empty-state message: distinguish "no data at all" from "no data at this grain".
  const emptyMsg =
    effectiveResolution === '15m'
      ? `No 15-minute data yet for ${FUEL_LABEL[fuel].toLowerCase()} — it's collected on each scheduled check.`
      : `No interval data yet for ${FUEL_LABEL[fuel].toLowerCase()} — it's collected on each scheduled check.`;

  // The chart body (render-prop for ChartShell): keeps the loading/empty/errored
  // states and the Recharts tree, drawn into the height ChartShell supplies.
  const renderBody = (h: number | string) => (
    <div style={{ height: h }} className="relative w-full">
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
      {/* Persistent "finest detail" badge (issue #141): shown whenever the route
          did NOT downsample, so the chart is at its native resolution and zooming
          further reveals nothing new. Sits top-right, opposite the Reset-zoom
          affordance, so the two never collide. */}
      {atFinestDetail && (
        <div
          title="The chart is at its finest available resolution — zooming further won't reveal more detail."
          className="pointer-events-none absolute right-1 top-1 z-10 rounded-md border border-slate-700 bg-slate-900/80 px-2 py-0.5 text-[11px] text-slate-400 backdrop-blur"
        >
          Max zoom · finest detail
        </div>
      )}
      {/* Transient refused-drag hint (issue #141): shown ~2s when a deliberate drag
          is tighter than the zoom floor. Centered at the top so it reads as a
          momentary toast, then auto-clears. */}
      {zoomHint && !loading && !errored && (
        <div className="pointer-events-none absolute left-1/2 top-1 z-20 -translate-x-1/2 rounded-md border border-amber-500/60 bg-slate-900/90 px-2 py-0.5 text-[11px] text-amber-300 backdrop-blur">
          Max zoom reached
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
              cancels an in-progress drag (also a safe place to commit so a drag
              that ends just off the plot still zooms). The cursor hints the
              gesture is a selection (crosshair). No persistent handle exists, so
              nothing can "snap back" the way the old Brush did. */}
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
              // Show a readable but not crowded set of tick labels.
              // For dense ranges (30d at 1h = ~720 points) minTickGap prevents
              // crowding; for sparse ranges (24h at 15m = ~96 points) it's fine.
              interval="preserveStartEnd"
            />
            <YAxis
              {...axisStyle}
              width={42}
              tickFormatter={(v: number) => Number(v).toFixed(effectiveResolution === '15m' ? 2 : 1)}
            />
            <Tooltip
              contentStyle={tooltipStyle}
              formatter={(v: number | string) => [`${Number(v).toFixed(3)} ${unit}`, 'usage']}
              labelFormatter={(l) => `${l}`}
            />
            {/* connectNulls={false} (the Recharts default) is load-bearing:
                missing intervals must render as line BREAKS, never as
                straight lines over a gap or fabricated zeros. We make it
                explicit here for clarity and to guard against future
                defaults changing. */}
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
            {/* The in-progress drag-selection band (issue #141). Drawn only while
                a drag spans two distinct x positions; it disappears on mouse-up
                (the zoom is committed and the data refetched for that span). */}
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
      settings={
        <HistorySettings
          fuel={fuel}
          onFuel={setFuel}
          resolution={effectiveResolution}
          onResolution={setResolution}
          resolutionDisabled={resolutionDisabled}
        />
      }
    />
  );
}
