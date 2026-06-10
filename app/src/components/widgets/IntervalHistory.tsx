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
// GAPS: the chart uses connectNulls=false (the default) so real gaps in the
// data (missing intervals — the API omits them) render as line breaks, NEVER
// as fabricated zeros.

import { useEffect, useMemo, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { reconcileToHourly, type IntervalProfileRow } from '@/lib/intervalProfile';
import { toHistoryPoints } from '@/lib/intervalHistory';
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

  // Fetch on mount + whenever controls or account change. Track an `alive` flag
  // so a stale response (the user changed a control mid-flight) can't overwrite
  // the current one.
  useEffect(() => {
    let alive = true;
    setState(undefined);
    const acctQuery = accountId != null ? `&accountId=${accountId}` : '';
    // Follow the GLOBAL range when supplied; otherwise let the route default to its
    // trailing window (non-dashboard caller). Server-side downsampling keeps the
    // returned series bounded (≤ MAX_POINTS) no matter how wide the window is.
    const rangeQuery = from && to ? `&from=${from}&to=${to}` : '';
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
  }, [fuel, from, to, accountId]);

  const color = fuel === 'GAS' ? GAS : ELEC;
  const unit = FUEL_UNIT[fuel];

  // Shape the raw rows into chart points. For 1h: run through reconcileToHourly
  // first (best hourly value, 15-min-summed where available), then toHistoryPoints.
  // For 15m: filter to intervalSeconds=900 only, then toHistoryPoints.
  // Missing rows = missing points (no zeros fabricated — connectNulls=false means
  // gaps render as line breaks in the chart, the correct behavior).
  const data = useMemo(() => {
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

  // Subtitle: e.g. "Electric · kWh · 1h" (the time window now follows the global
  // RangeControl, shown in the dashboard header, so it isn't repeated here).
  const subtitle = `${FUEL_LABEL[fuel]} · ${unit} · ${effectiveResolution}`;

  // Empty-state message: distinguish "no data at all" from "no data at this grain".
  const emptyMsg =
    effectiveResolution === '15m'
      ? `No 15-minute data yet for ${FUEL_LABEL[fuel].toLowerCase()} — it's collected on each scheduled check.`
      : `No interval data yet for ${FUEL_LABEL[fuel].toLowerCase()} — it's collected on each scheduled check.`;

  // The chart body (render-prop for ChartShell): keeps the loading/empty/errored
  // states and the Recharts tree, drawn into the height ChartShell supplies.
  const renderBody = (h: number | string) => (
    <div style={{ height: h }} className="w-full">
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
