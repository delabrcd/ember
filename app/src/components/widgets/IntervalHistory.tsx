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
// sub-span LOCALLY (a Recharts Brush at the chart foot) without mutating the
// global RangeControl. The brush is a CONTROLLED component — its [startIndex,
// endIndex] live in React state and are passed back to <Brush>; every onChange
// just updates those indices, so Recharts zooms the main chart to the selection
// SMOOTHLY with NO data change (this is what fixes the #141 snap-back: an
// uncontrolled brush + a mid-drag refetch reset the brush to the full range).
//
// The finer-detail refetch is DECOUPLED from the visual zoom and DEBOUNCED: only
// ~ZOOM_DEBOUNCE_MS after the drag settles do we (if the span is narrow enough —
// shouldRefetchZoom) REFETCH /api/interval for just that span to show finer (less
// server-downsampled) detail. The refetch swaps the rows IN PLACE — it never
// blanks the chart to the loading skeleton (only the fuel/account/global-range
// load does that) — and on arrival the controlled brush is reconciled to span
// the new (zoomed) data, so the view stays put: no flash, no jump, no snap.
//
// A "Reset zoom" affordance returns to the global window. The zoom is per-widget
// ephemeral state (lib/intervalZoom.ts holds the pure span/refetch/index math).
//
// GAPS: the chart uses connectNulls=false (the default) so real gaps in the
// data (missing intervals — the API omits them) render as line breaks, NEVER
// as fabricated zeros. This holds through zoom + refetch (the refetch path runs
// the same toHistoryPoints shaper, which drops gaps).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Brush,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { reconcileToHourly, type IntervalProfileRow } from '@/lib/intervalProfile';
import { toHistoryPoints, type HistoryPoint } from '@/lib/intervalHistory';
import { clampBrushIndices, shouldRefetchZoom, zoomSpanToRange } from '@/lib/intervalZoom';
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

// ---- Zoom-refetch tuning ----------------------------------------------------
// A brushed span is refetched for finer detail when it is ≤ ZOOM_MAX_SPAN_DAYS
// wide AND ≤ ZOOM_SHRINK_RATIO of the currently-fetched span (see
// lib/intervalZoom.shouldRefetchZoom). 14 days bounds the refetch payload while
// still covering a typical "zoom into a week or two" gesture; 0.5 means the zoom
// must at least halve the window to be worth a refetch.
const ZOOM_MAX_SPAN_DAYS = 14;
const ZOOM_SHRINK_RATIO = 0.5;
// How long after the LAST brush onChange we wait before firing the finer-detail
// refetch. The refetch is deferred to after the drag settles so it never yanks
// the data out from under an active drag (the #141 snap-back). 350ms is long
// enough to coalesce a continuous drag into one fetch, short enough to feel
// responsive once the user lets go.
const ZOOM_DEBOUNCE_MS = 350;

// ---- Types ------------------------------------------------------------------
type Fuel = 'ELECTRIC' | 'GAS';
type Resolution = '1h' | '15m';

const FUELS: readonly Fuel[] = ['ELECTRIC', 'GAS'];
const FUEL_LABEL: Record<Fuel, string> = { ELECTRIC: 'Electric', GAS: 'Gas' };
const FUEL_UNIT: Record<Fuel, string> = { ELECTRIC: 'kWh', GAS: 'therms' };

// The /api/interval payload rows (fuelType + unit from the API, plus the
// IntervalProfileRow fields the shapers need).
type IntervalApiRow = IntervalProfileRow & { fuelType?: string; unit?: string };

type LoadState = { rows: IntervalApiRow[] } | { error: true } | undefined;

// A locally-zoomed window: the day bounds we refetched for finer detail, plus the
// raw ms span the user brushed (so the reset/label can describe it). Ephemeral
// per-widget state — it never touches the global RangeControl.
type Zoom = { from: string; to: string; startMs: number; endMs: number };

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
  // The CONTROLLED brush selection (issue #141): indices into the rendered
  // `data`. `null` means "no explicit selection" → the brush spans the full
  // series. Driving these from state (vs an uncontrolled brush) is what keeps a
  // drag from snapping back: onChange updates them, Recharts zooms smoothly, and
  // the data underneath never changes mid-drag.
  const [brush, setBrush] = useState<{ startIndex: number; endIndex: number } | null>(null);
  // After a finer-detail refetch lands, the new `data` IS the zoomed span — so the
  // controlled brush should span the WHOLE new series, keeping the view on that
  // span (no jump/snap). This ref flags "the next data arrival was caused by a
  // zoom refetch; reconcile the brush to full range when it lands."
  const reconcileBrushRef = useRef(false);
  // A debounce timer for the finer-detail refetch (issue #141): the visual zoom
  // updates instantly via the controlled brush; the refetch is deferred until the
  // drag settles so it never disturbs an active drag.
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Drop any active zoom (and the brush selection) whenever the fuel, the
  // account, or the GLOBAL range changes — a zoom into the old context would be
  // stale (the reset is then a no-op the next fetch already reflects). Resolution
  // does NOT clear the zoom (the user may be zooming specifically to inspect 15m
  // detail), but it DOES drop the brush selection: switching 1h↔15m changes the
  // point count, so the old indices no longer map to the same span.
  useEffect(() => {
    setZoom(null);
    setBrush(null);
  }, [fuel, from, to, accountId]);
  useEffect(() => {
    setBrush(null);
  }, [effectiveResolution]);

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
    fetch(`/api/interval?fuel=${fuel}${rangeQuery}${acctQuery}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        setState({ rows: Array.isArray(j?.rows) ? (j.rows as IntervalApiRow[]) : [] });
      })
      .catch(() => {
        if (alive) setState({ error: true });
      });
    return () => {
      alive = false;
    };
  }, [fuel, fetchFrom, fetchTo, accountId, from, to]);

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

  // Reconcile the CONTROLLED brush whenever `data` changes (issue #141):
  //   • If a zoom refetch just landed (reconcileBrushRef), the new `data` IS the
  //     zoomed span → span the WHOLE new series so the view stays on that span.
  //   • Otherwise, if an existing selection now falls out of bounds (e.g. a
  //     resolution change shrank the series), clamp it back into range; a brush
  //     spanning the full series collapses to "no selection" (null) so the
  //     overview shows the whole window.
  // Depends on `data` ONLY (the reconciliation is a response to the series
  // changing). The current `brush` is read inside the functional `setBrush`
  // updater rather than via a closure capture, so we don't need it in the deps and
  // the reconciliation can't re-trigger itself when it updates the brush.
  const len = data.length;
  useEffect(() => {
    const reconcile = reconcileBrushRef.current;
    reconcileBrushRef.current = false;
    setBrush((prev) => {
      if (len === 0) return null;
      const last = len - 1;
      // A zoom refetch just landed: the new data IS the zoomed span → span it all.
      if (reconcile) {
        return prev && prev.startIndex === 0 && prev.endIndex === last
          ? prev
          : { startIndex: 0, endIndex: last };
      }
      if (!prev) return prev;
      // Full-range selection → drop to null (overview, no zoom box).
      if (prev.startIndex <= 0 && prev.endIndex >= last) return null;
      const clamped = clampBrushIndices(prev.startIndex, prev.endIndex, len);
      return clamped.startIndex === prev.startIndex && clamped.endIndex === prev.endIndex
        ? prev
        : clamped;
    });
  }, [len]);

  // The ms span currently FETCHED, derived from the rendered points (the first and
  // last point). Used as the baseline shouldRefetchZoom compares a brush against.
  const fetchedSpan = useMemo(() => {
    if (data.length < 2) return null;
    return { fromMs: data[0].ts, toMs: data[data.length - 1].ts };
  }, [data]);

  // Brush handler: the user is dragging the foot navigator. Recharts gives us the
  // selected start/end indices into `data`. We (1) update the CONTROLLED brush
  // immediately so the chart zooms smoothly with no data change (the snap-back
  // fix), and (2) DEBOUNCE a finer-detail decision: only after the drag settles,
  // if the brushed span warrants it (pure shouldRefetchZoom), set a zoom so the
  // fetch effect refetches /api/interval for just that span. A brush that isn't
  // narrow enough leaves `zoom` alone (the visual brush still narrows the view; we
  // just don't pay for a refetch).
  const onBrushChange = useCallback(
    (range: { startIndex?: number; endIndex?: number }) => {
      const s = range.startIndex;
      const e = range.endIndex;
      if (s == null || e == null) return;
      // 1) Visual zoom — update the controlled brush right away (clamped/ordered).
      const next = clampBrushIndices(s, e, data.length);
      setBrush((prev) =>
        prev && prev.startIndex === next.startIndex && prev.endIndex === next.endIndex
          ? prev
          : next,
      );
      // 2) Debounced finer-detail refetch — evaluated against the SETTLED span.
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = setTimeout(() => {
        refetchTimerRef.current = null;
        if (!fetchedSpan) return;
        if (next.startIndex >= next.endIndex) return;
        const startMs = data[next.startIndex]?.ts;
        const endMs = data[next.endIndex]?.ts;
        if (startMs == null || endMs == null) return;
        if (
          shouldRefetchZoom(startMs, endMs, fetchedSpan.fromMs, fetchedSpan.toMs, {
            maxSpanDays: ZOOM_MAX_SPAN_DAYS,
            shrinkRatio: ZOOM_SHRINK_RATIO,
          })
        ) {
          const { from: zf, to: zt } = zoomSpanToRange(startMs, endMs);
          // Avoid a redundant refetch if we're already zoomed to that exact span.
          setZoom((prev) => {
            if (prev && prev.from === zf && prev.to === zt) return prev;
            reconcileBrushRef.current = true;
            return { from: zf, to: zt, startMs, endMs };
          });
        }
      }, ZOOM_DEBOUNCE_MS);
    },
    [data, fetchedSpan],
  );

  // Clean up a pending debounce timer on unmount (avoid a stray setState).
  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, []);

  const resetZoom = useCallback(() => {
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = null;
    }
    reconcileBrushRef.current = false;
    setZoom(null);
    setBrush(null);
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
          <LineChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
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
              {/* Brush (issue #141): the drag-to-zoom navigator. It is CONTROLLED
                  — startIndex/endIndex come from `brush` state and are updated in
                  onBrushChange — so dragging zooms the main chart smoothly with NO
                  data change (this is the snap-back fix). A narrow settled span
                  triggers a DEBOUNCED finer-detail refetch (shouldRefetchZoom)
                  that swaps data in place without blanking the chart.
                  `dataKey="label"` matches the XAxis.
                  The `key` ties the brush's internal state to the current series
                  length so a data swap re-seeds it cleanly with our indices. */}
              <Brush
                key={data.length}
                dataKey="label"
                height={18}
                travellerWidth={8}
                stroke="#475569"
                fill="#0f172a"
                startIndex={brush?.startIndex}
                endIndex={brush?.endIndex}
                onChange={onBrushChange}
              />
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
