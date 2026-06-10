'use client';

// The interval LOAD-SHAPE widget (issue #76): a self-contained dashboard tile
// showing the AVERAGE DAY profile from smart-meter interval data — "what does a
// typical day look like?". Electric (15-min kWh) by default, with a gas (hourly
// therms) toggle.
//
// SELF-FETCHING (deliberately contained): unlike the monthly charts — which the
// host resolves through the dataset plumbing — this widget owns its own data. On
// mount (and whenever the fuel toggle or the selected account changes) it fetches
// /api/interval, shapes the rows with the PURE averageDayProfile, and draws the
// result with Recharts. It does NOT touch the ChartSpec/ConfigurableChart seam
// (the `profile` vizType's renderer is the separate #95 refactor).

import { useEffect, useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { averageDayProfile, reconcileToHourly, type IntervalProfileRow } from '@/lib/intervalProfile';
import { ChartShell } from '../ChartShell';

// The dashboard's dark-slate theme + the elec amber / gas blue tokens (mirrors
// chartSpec.ts and ConfigurableChart so the widget matches the surrounding charts).
const ELEC = '#f59e0b';
const GAS = '#38bdf8';
// AMI meters lag ~1–2 days (the freshest hours read 0, then fill in). Exclude the
// last SETTLE_HOURS from the average-day profile so those provisional zeros don't
// bias the curve down. 48h covers the typical lag with margin.
const SETTLE_HOURS = 48;
const tooltipStyle = { backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, fontSize: 12 } as const;
const axisStyle = { stroke: '#475569', fontSize: 11 } as const;

type Fuel = 'ELECTRIC' | 'GAS';
const FUELS: readonly Fuel[] = ['ELECTRIC', 'GAS'];
const FUEL_LABEL: Record<Fuel, string> = { ELECTRIC: 'Electric', GAS: 'Gas' };
const FUEL_UNIT: Record<Fuel, string> = { ELECTRIC: 'kWh', GAS: 'therms' };

// The /api/interval payload (raw IntervalUsage-like rows). intervalStart arrives
// as a JSON string; the PURE shaper tolerates both string + Date.
type IntervalApiRow = IntervalProfileRow & { fuelType?: string; unit?: string };

// A loaded fetch state per fuel: undefined = still loading, an array (possibly
// empty) = loaded.
type LoadState = { rows: IntervalApiRow[] } | { error: true } | undefined;

// A labelled segmented control matching ConfigurableChart's Segmented, but with
// distinct option value/label (the fuel enum is uppercase, the label is not).
function LabelledSegmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { label: string; value: T }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`px-2.5 py-1 text-xs transition ${
            value === o.value ? 'bg-amber-500 text-slate-950' : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// The settings panel rendered inside ChartShell's Customize popover / expand side.
// Mirrors ChartConfigMenu's row layout (uppercase label + a segmented control).
function LoadShapeSettings({ fuel, onFuel }: { fuel: Fuel; onFuel: (f: Fuel) => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Fuel</div>
        <LabelledSegmented
          value={fuel}
          options={FUELS.map((f) => ({ label: FUEL_LABEL[f], value: f }))}
          onChange={onFuel}
        />
      </div>
    </div>
  );
}

// `from`/`to` are the GLOBAL RangeControl's resolved ISO day bounds (issue #36),
// supplied by the WidgetHost. The shape averages over this window instead of a
// fixed trailing 30 days. Omitted (a non-dashboard caller) → the route falls back
// to its trailing 30-day window.
export function IntervalLoadShape({
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

  // Fetch on mount + whenever the fuel, the global range, or the selected account
  // changes. We track an `alive` flag so a stale response (the user flicked the
  // toggle mid-flight) can't overwrite the current one.
  useEffect(() => {
    let alive = true;
    setState(undefined);
    const acctQuery = accountId != null ? `&accountId=${accountId}` : '';
    // Average over the GLOBAL range when supplied; otherwise let the route default
    // to its trailing window. The profile shapes to 24 buckets regardless of span,
    // so no downsampling is needed here.
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

  // Shape the raw reads into the average-day profile (PURE), then derive the
  // stacked-area band fields: `base` = min (a transparent floor) and `band` =
  // max − min (the filled spread drawn ON TOP of the floor via a shared stackId).
  // Stacking two areas is the dependency-free way to draw a min–max band in
  // Recharts (it has no native band series) and is robust regardless of the card
  // background. Memoized on the loaded rows so a resize doesn't re-bucket.
  const data = useMemo(() => {
    if (!state || 'error' in state) return [];
    // Exclude the unsettled tail (last ~48h): AMI meters report the freshest hours
    // as 0 and fill in later, which would bias the "typical day" curve down. A
    // typical-day profile doesn't need the last couple of days anyway.
    const before = new Date(Date.now() - SETTLE_HOURS * 3600_000);
    // Reconcile dual-grain input (15-min + hourly may coexist for ELECTRIC) before
    // profiling. A complete four-slot 15-min hour wins over its hourly counterpart;
    // an incomplete 15-min hour without a paired hourly row is dropped. This ensures
    // no double-count and no partial-hour underreporting. The `before` cutoff is
    // applied afterwards by averageDayProfile (order matters: reconcile → then cut).
    return averageDayProfile(reconcileToHourly(state.rows), { before }).map((b) => ({
      ...b,
      base: b.min,
      band: b.max - b.min,
    }));
  }, [state]);

  const loading = state === undefined;
  const errored = !!state && 'error' in state;
  const empty = !loading && !errored && data.length === 0;

  // The chart body (render-prop for ChartShell): keeps the loading/empty/errored
  // states and the Recharts tree, just drawn into the height ChartShell supplies
  // (the grid cell at "100%" in the card, or "80vh" in the Expand modal).
  const renderBody = (h: number | string) => (
    <div style={{ height: h }} className="w-full">
      {loading ? (
        // Loading: a muted skeleton bar (the chart area's height is the grid
        // cell's, via the flex-1 min-h-0 chain).
        <div className="flex h-full w-full items-center justify-center">
          <div className="h-full w-full animate-pulse rounded-lg bg-slate-800/40" />
        </div>
      ) : errored ? (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-xs text-slate-400">
          Couldn&apos;t load interval data — try again on the next check.
        </div>
      ) : empty ? (
        // Empty: a friendly muted message, NOT a broken blank chart.
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-slate-400">
          <span>
            No interval data yet{fuel === 'GAS' ? ' for gas' : ''} — it&apos;s collected on each scheduled check.
          </span>
        </div>
      ) : (
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="#1e293b" vertical={false} />
              <XAxis dataKey="label" {...axisStyle} minTickGap={24} />
              <YAxis {...axisStyle} width={40} tickFormatter={(v) => Number(v).toFixed(1)} />
              <Tooltip
                contentStyle={tooltipStyle}
                // Only the mean curve carries a meaningful tooltip value; the two
                // band areas are visual-only (Recharts has no native band series).
                formatter={(v: number | string, name) =>
                  name === 'mean' ? [`${Number(v).toFixed(3)} ${unit}`, 'mean'] : ([] as never)
                }
                labelFormatter={(l) => `${l}`}
              />
              {/* Min–max spread band via two STACKED areas: a transparent `base`
                  floor (the per-bucket min) + a faint `band` (max − min) filled on
                  top. Stacking is the dependency-free way to draw a band in
                  Recharts, robust regardless of the card background. */}
              <Area
                type="monotone"
                dataKey="base"
                stackId="band"
                stroke="none"
                fill="none"
                fillOpacity={0}
                isAnimationActive={false}
                connectNulls
                legendType="none"
              />
              <Area
                type="monotone"
                dataKey="band"
                stackId="band"
                stroke="none"
                fill={color}
                fillOpacity={0.14}
                isAnimationActive={false}
                connectNulls
                legendType="none"
              />
              <Line
                type="monotone"
                dataKey="mean"
                name="mean"
                stroke={color}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
                connectNulls
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    );

  return (
    <ChartShell
      title="Average daily load shape"
      subtitle={`Typical day · ${unit}`}
      fill
      body={renderBody}
      settings={<LoadShapeSettings fuel={fuel} onFuel={setFuel} />}
    />
  );
}
