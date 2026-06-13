'use client';

// The interval HEATMAP widget (issue #77): a self-contained dashboard tile
// showing a DAY-OF-WEEK × HOUR-OF-DAY usage intensity grid from smart-meter
// interval data — "when in the week is my house busiest?". Electric (kWh) by
// default, with a gas (therms) toggle. It also surfaces the PEAK-DEMAND readout
// (the highest average power over any single interval, and when it occurred).
//
// SERVER-SIDE AGGREGATION (issue #77 data-correctness fix): the grid + peak are
// computed SERVER-SIDE over the RAW, un-downsampled interval rows by
// /api/interval/heatmap (pure buildHeatmapPayload). Previously this widget fetched
// /api/interval — which DOWNSAMPLES to ≤600 points by absolute time for the
// history line — and binned client-side, which merged adjacent hours and showed
// spurious "no data" cells on wide ranges. We now render the display-ready grid
// the server returns directly via HeatmapViz's `grid`/`rowLabels` props (no
// client re-aggregation), so every (dow, hour) cell that truly has data is
// populated and a genuinely-absent cell stays null (never a fabricated zero).
//
// SELF-FETCHING (mirrors IntervalLoadShape / IntervalHistory): owns its own data,
// scoped to host.accountId, following the GLOBAL RangeControl via from/to props,
// with an alive-flag against stale responses and ChartShell chrome.

import { useEffect, useState } from 'react';
import type { HeatmapVizSpec } from '@/lib/chartSpec';
import type { HeatmapRow } from '@/lib/intervalProfile';
import type { HeatmapPayload } from '@/lib/intervalAggregate';
import { HeatmapViz } from './VizCharts';
import { ChartShell } from '../ChartShell';

type Fuel = 'ELECTRIC' | 'GAS';
const FUELS: readonly Fuel[] = ['ELECTRIC', 'GAS'];
const FUEL_LABEL: Record<Fuel, string> = { ELECTRIC: 'Electric', GAS: 'Gas' };
const FUEL_UNIT: Record<Fuel, string> = { ELECTRIC: 'kWh', GAS: 'therms' };
// Peak demand is average POWER over the interval: kW for electric, therms/h for gas.
const POWER_UNIT: Record<Fuel, string> = { ELECTRIC: 'kW', GAS: 'therms/h' };

// undefined = still loading; an error sentinel; else the server-computed payload.
type LoadState = HeatmapPayload | { error: true } | undefined;

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
  // Track an `alive` flag so a stale response can't overwrite the current one. The
  // server returns the display-ready grid + rowLabels + peak (aggregated over the
  // RAW rows) — there is NO client-side aggregation to redo.
  useEffect(() => {
    let alive = true;
    setState(undefined);
    const acctQuery = accountId != null ? `&accountId=${accountId}` : '';
    const rangeQuery = from && to ? `&from=${from}&to=${to}` : '';
    fetch(`/api/interval/heatmap?fuel=${fuel}${rangeQuery}${acctQuery}`)
      .then((r) => r.json())
      .then((j) => {
        if (!alive) return;
        // Defensive: a well-formed payload always carries a grid; treat anything
        // else as an empty grid so the widget shows its empty state, not a crash.
        if (j && j.grid && Array.isArray(j.grid.cells)) {
          setState(j as HeatmapPayload);
        } else {
          setState({ grid: { xs: [], ys: [], cells: [], min: 0, max: 0 }, rowLabels: {}, peak: null });
        }
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

  const loading = state === undefined;
  const errored = !!state && 'error' in state;
  const payload = !loading && !errored ? (state as HeatmapPayload) : null;
  const empty = !!payload && payload.grid.cells.length === 0;
  const peak = payload?.peak ?? null;

  // The heatmap spec: day-of-week (y) × hour-of-day (x), colored by usage. The
  // grid is pre-aggregated server-side; the spec only supplies field names (for
  // the value label) — HeatmapViz reads the grid/rowLabels props, not the rows.
  const spec: HeatmapVizSpec<HeatmapRow> = {
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
  };

  const peakReadout = peak
    ? `Peak ${peak.value.toFixed(peak.value < 10 ? 2 : 1)} ${powerUnit} · ${peakFmt.format(new Date(peak.intervalStart))}`
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
                the flex remainder via a min-h-0 flex-1 wrapper. We pass the
                SERVER-computed grid + rowLabels (no client re-aggregation). */}
            <div className="min-h-0 flex-1">
              <HeatmapViz
                spec={spec}
                grid={payload!.grid}
                rowLabels={payload!.rowLabels}
                height={pxHeight ?? 260}
              />
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
