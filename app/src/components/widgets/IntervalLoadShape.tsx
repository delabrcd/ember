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
import { averageDayProfile, type IntervalProfileRow } from '@/lib/intervalProfile';

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

// The fuel toggle — a segmented control mirroring ConfigurableChart's Segmented.
function FuelToggle({ value, onChange }: { value: Fuel; onChange: (f: Fuel) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
      {FUELS.map((f) => (
        <button
          key={f}
          onClick={() => onChange(f)}
          className={`px-2.5 py-1 text-xs transition ${
            value === f ? 'bg-amber-500 text-slate-950' : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'
          }`}
        >
          {FUEL_LABEL[f]}
        </button>
      ))}
    </div>
  );
}

export function IntervalLoadShape({ accountId }: { accountId?: number | null }) {
  const [fuel, setFuel] = useState<Fuel>('ELECTRIC');
  const [state, setState] = useState<LoadState>(undefined);

  // Fetch on mount + whenever the fuel or the selected account changes. We track
  // an `alive` flag so a stale response (the user flicked the toggle mid-flight)
  // can't overwrite the current one.
  useEffect(() => {
    let alive = true;
    setState(undefined);
    const acctQuery = accountId != null ? `&accountId=${accountId}` : '';
    fetch(`/api/interval?fuel=${fuel}&sinceDays=30${acctQuery}`)
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
  }, [fuel, accountId]);

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
    return averageDayProfile(state.rows, { before }).map((b) => ({ ...b, base: b.min, band: b.max - b.min }));
  }, [state]);

  const loading = state === undefined;
  const errored = !!state && 'error' in state;
  const empty = !loading && !errored && data.length === 0;

  return (
    <div className="card relative flex h-full min-h-0 flex-col !p-2.5">
      <div className="mb-1 flex shrink-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-100">Average daily load shape</h3>
          <p className="truncate text-xs text-slate-400">Typical day · {unit} · last 30 days</p>
        </div>
        <div className="shrink-0">
          <FuelToggle value={fuel} onChange={setFuel} />
        </div>
      </div>

      <div className="min-h-0 flex-1">
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
    </div>
  );
}
