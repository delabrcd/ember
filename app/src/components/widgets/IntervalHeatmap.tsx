'use client';

// The interval HEATMAP widget (issue #77): a self-contained dashboard tile
// showing a DAY-OF-WEEK × HOUR-OF-DAY usage intensity grid from smart-meter
// interval data — "when in the week is my house busiest?". Electric (kWh) by
// default, with a gas (therms) toggle. It also surfaces the PEAK-DEMAND readout
// (the highest average power over any single interval, and when it occurred).
//
// REUSE, not rebuild: the grid is drawn by the EXISTING HeatmapViz renderer
// (VizCharts.tsx) over the EXISTING pure aggregator dayHourHeatmap (lib/viz/
// aggregate.ts) — the same path the #95 demo gallery uses. This widget's only job
// is the impure shell: fetch /api/interval, reconcile dual-grain rows to hourly,
// reshape them into the {hour, dow, value} rows the heatmap encoding expects via
// the PURE dayHourHeatmapRows, and feed them to HeatmapViz. All arithmetic
// (binning, color scale, peak) lives in the pure libs, hand-calc tested.
//
// SELF-FETCHING (mirrors IntervalLoadShape / IntervalHistory): owns its own data,
// scoped to host.accountId, following the GLOBAL RangeControl via from/to props,
// with an alive-flag against stale responses and ChartShell chrome.

import { useEffect, useMemo, useState } from 'react';
import type { HeatmapVizSpec } from '@/lib/chartSpec';
import {
  dayHourHeatmapRows,
  peakDemand,
  reconcileToHourly,
  type HeatmapRow,
  type IntervalProfileRow,
} from '@/lib/intervalProfile';
import { HeatmapViz } from './VizCharts';
import { ChartShell } from '../ChartShell';

// AMI meters lag ~1–2 days (the freshest hours read 0, then fill in). Exclude the
// last SETTLE_HOURS from the heatmap so those provisional zeros don't drag a cell's
// average down. 48h covers the typical lag with margin (mirrors IntervalLoadShape).
const SETTLE_HOURS = 48;

type Fuel = 'ELECTRIC' | 'GAS';
const FUELS: readonly Fuel[] = ['ELECTRIC', 'GAS'];
const FUEL_LABEL: Record<Fuel, string> = { ELECTRIC: 'Electric', GAS: 'Gas' };
const FUEL_UNIT: Record<Fuel, string> = { ELECTRIC: 'kWh', GAS: 'therms' };
// Peak demand is average POWER over the interval: kW for electric, therms/h for gas.
const POWER_UNIT: Record<Fuel, string> = { ELECTRIC: 'kW', GAS: 'therms/h' };

// The /api/interval payload rows (raw IntervalUsage-like). intervalStart arrives
// as a JSON string; the PURE shapers tolerate both string + Date.
type IntervalApiRow = IntervalProfileRow & { fuelType?: string; unit?: string };

type LoadState = { rows: IntervalApiRow[] } | { error: true } | undefined;

// A labelled segmented control (mirrors IntervalLoadShape's LabelledSegmented).
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

function HeatmapSettings({ fuel, onFuel }: { fuel: Fuel; onFuel: (f: Fuel) => void }) {
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

// Format the peak-demand instant in the account's local clock as "Mon 6pm-ish":
// short weekday + 12-h hour. PURE-ish (uses Intl with a fixed tz).
const PEAK_TZ = 'America/New_York';
const peakFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: PEAK_TZ,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  hour12: true,
});

// `from`/`to` are the GLOBAL RangeControl's resolved ISO day bounds (issue #36),
// supplied by the WidgetHost. Omitted (a non-dashboard caller) → the route falls
// back to its trailing window.
export function IntervalHeatmap({
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

  // Fetch on mount + whenever the fuel, the global range, or the account changes.
  // Track an `alive` flag so a stale response can't overwrite the current one.
  useEffect(() => {
    let alive = true;
    setState(undefined);
    const acctQuery = accountId != null ? `&accountId=${accountId}` : '';
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

  const unit = FUEL_UNIT[fuel];
  const powerUnit = POWER_UNIT[fuel];

  // Reconcile dual-grain rows to hourly, then reshape into the day×hour heatmap
  // rows (PURE). Exclude the unsettled tail (last ~48h) so lagged zeros don't bias
  // a cell's average. Memoized on the loaded rows so a resize doesn't re-bucket.
  const heatRows: HeatmapRow[] = useMemo(() => {
    if (!state || 'error' in state) return [];
    const before = new Date(Date.now() - SETTLE_HOURS * 3600_000);
    return dayHourHeatmapRows(reconcileToHourly(state.rows), { before });
  }, [state]);

  // Peak demand from the RAW reads (NOT reconciled): the finest grain available
  // gives the truest peak (a 15-min spike reads higher kW than its hour's mean).
  // We exclude the unsettled tail here too so a lagged 0 hour can't masquerade and,
  // more importantly, a partially-filled fresh interval can't read as a false peak.
  const peak = useMemo(() => {
    if (!state || 'error' in state) return null;
    const beforeMs = Date.now() - SETTLE_HOURS * 3600_000;
    const settled = state.rows.filter((r) => {
      const t = (r.intervalStart instanceof Date ? r.intervalStart : new Date(r.intervalStart)).getTime();
      return Number.isFinite(t) && t < beforeMs;
    });
    return peakDemand(settled);
  }, [state]);

  // The heatmap spec: day-of-week (y) × hour-of-day (x), colored by usage. The
  // encoding keys onto the HeatmapRow fields dayHourHeatmapRows emits, so it's
  // type-checked against the real row shape (not the #95 sample row).
  const spec: HeatmapVizSpec<HeatmapRow> = useMemo(
    () => ({
      id: 'interval-heatmap',
      vizType: 'heatmap',
      dataset: 'interval',
      title: 'Usage by day & hour',
      encoding: {
        x: 'hour',
        y: 'dow',
        value: 'value',
        yLabelField: 'dowLabel',
        valueLabel: unit,
      },
    }),
    [unit]
  );

  const loading = state === undefined;
  const errored = !!state && 'error' in state;
  const empty = !loading && !errored && heatRows.length === 0;

  const peakReadout = peak
    ? `Peak ${peak.value.toFixed(peak.value < 10 ? 2 : 1)} ${powerUnit} · ${peakFmt.format(peak.intervalStart)}`
    : null;

  // The chart body (render-prop for ChartShell). `h` is a px number in the grid
  // cell (100% / 80vh come through as strings) — HeatmapViz wants a px height, so
  // we coerce a string to a sensible default and let its SVG scale to the box.
  const renderBody = (h: number | string) => {
    const pxHeight = typeof h === 'number' ? h : undefined;
    return (
      <div style={{ height: h }} className="flex w-full flex-col">
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
            <span>
              No interval data yet{fuel === 'GAS' ? ' for gas' : ''} — it&apos;s collected on each scheduled check.
            </span>
          </div>
        ) : (
          <>
            {/* Peak-demand readout caption (#77): value + when. Hidden if no peak. */}
            {peakReadout && (
              <div className="mb-1 shrink-0 text-xs text-slate-400">
                <span className="font-medium text-slate-200">{peakReadout}</span>
              </div>
            )}
            {/* The grid fills the remaining height. HeatmapViz draws a scalable SVG
                inside a box of the height we pass; in the fill cell we let it take
                the flex remainder via a min-h-0 flex-1 wrapper. */}
            <div className="min-h-0 flex-1">
              <HeatmapViz spec={spec} rows={heatRows} height={pxHeight ?? 260} />
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <ChartShell
      title="Usage by day & hour"
      subtitle={`Avg ${unit} · day-of-week × hour`}
      fill
      body={renderBody}
      settings={<HeatmapSettings fuel={fuel} onFuel={setFuel} />}
    />
  );
}
