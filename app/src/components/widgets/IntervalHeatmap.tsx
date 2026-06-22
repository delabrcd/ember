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

import { useState } from 'react';
import type { HeatmapVizSpec } from '@/lib/chartSpec';
import { formatPeakReadout, type HeatmapRow } from '@/lib/intervalProfile';
import type { HeatmapPayload } from '@/lib/intervalAggregate';
import { useIntervalPayload } from '@/lib/hooks/useIntervalPayload';
import { Segmented } from './Segmented';
import { IntervalWidgetBody } from './IntervalWidgetBody';
import { HeatmapViz } from './VizCharts';
import { ChartShell } from '../ChartShell';

type Fuel = 'ELECTRIC' | 'GAS';
const FUELS: readonly Fuel[] = ['ELECTRIC', 'GAS'];
const FUEL_LABEL: Record<Fuel, string> = { ELECTRIC: 'Electric', GAS: 'Gas' };
const FUEL_UNIT: Record<Fuel, string> = { ELECTRIC: 'kWh', GAS: 'therms' };
// Peak demand is average POWER over the interval: kW for electric, therms/h for gas.
const POWER_UNIT: Record<Fuel, string> = { ELECTRIC: 'kW', GAS: 'therms/h' };

function HeatmapSettings({ fuel, onFuel }: { fuel: Fuel; onFuel: (f: Fuel) => void }) {
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Fuel</div>
        <Segmented
          value={fuel}
          options={FUELS.map((f) => ({ label: FUEL_LABEL[f], value: f }))}
          onChange={onFuel}
        />
      </div>
    </div>
  );
}

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

  // Fetch on mount + whenever the fuel, the global range, or the account changes.
  // #150: the shared useIntervalPayload hook owns the fetch lifecycle +
  // stale-response guard; the `validate` here keeps this widget's DISTINCT shape
  // check + empty fallback (a well-formed payload always carries a grid; anything
  // else → an empty grid so the widget shows its empty state, not a crash). The
  // server returns the display-ready grid + rowLabels + peak (aggregated over the
  // RAW rows) — there is NO client-side aggregation to redo.
  const acctQuery = accountId != null ? `&accountId=${accountId}` : '';
  const rangeQuery = from && to ? `&from=${from}&to=${to}` : '';
  const url = `/api/interval/heatmap?fuel=${fuel}${rangeQuery}${acctQuery}`;
  const { loading, errored, payload } = useIntervalPayload<HeatmapPayload>(url, (j) => {
    const p = j as HeatmapPayload | null;
    if (p && p.grid && Array.isArray(p.grid.cells)) return p;
    return { grid: { xs: [], ys: [], cells: [], min: 0, max: 0 }, rowLabels: {}, peak: null };
  });

  const unit = FUEL_UNIT[fuel];
  const powerUnit = POWER_UNIT[fuel];

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

  // #150: the pure, hand-calc-tested formatPeakReadout (shaping out of the component).
  const peakReadout = formatPeakReadout(peak, powerUnit);

  // The chart body (render-prop for ChartShell). `h` is a px number in the grid
  // cell (100% / 80vh come through as strings) — HeatmapViz wants a px height, so
  // we coerce a string to a sensible default and let its SVG scale to the box.
  const renderBody = (h: number | string) => {
    const pxHeight = typeof h === 'number' ? h : undefined;
    return (
      <IntervalWidgetBody
        height={h}
        loading={loading}
        errored={errored}
        empty={empty}
        emptyMessage={
          <span>
            No interval data yet{fuel === 'GAS' ? ' for gas' : ''} — it&apos;s collected on each scheduled check.
          </span>
        }
      >
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
      </IntervalWidgetBody>
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
