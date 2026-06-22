'use client';

// The interval LOAD-SHAPE widget (issue #76): a self-contained dashboard tile
// showing the AVERAGE DAY profile from smart-meter interval data — "what does a
// typical day look like?". Electric (15-min kWh) by default, with a gas (hourly
// therms) toggle.
//
// SERVER-SIDE AGGREGATION (issue #77 data-correctness fix): the average-day
// profiles + peak are computed SERVER-SIDE over the RAW, un-downsampled interval
// rows by /api/interval/profile (pure buildProfilePayload). Previously this widget
// fetched /api/interval — which DOWNSAMPLES to ≤600 points by absolute time for
// the history line — and shaped client-side; over a wide range each returned point
// could be ~32h averaged, destroying the hour-of-day structure. The route now
// returns ALL toggle variants (split × granularity) in one payload, so the
// weekday/weekend/combined + 1h/15m toggles stay INSTANT (no per-toggle refetch);
// only the fuel / range / account changing triggers a refetch.

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
import { formatPeakReadout, type ProfileBucket } from '@/lib/intervalProfile';
import type { ProfilePayload } from '@/lib/intervalAggregate';
import { TOOLTIP_STYLE, AXIS_STYLE, FUEL_COLORS } from '@/lib/chartTheme';
import { useIntervalPayload } from '@/lib/hooks/useIntervalPayload';
import { Segmented } from './Segmented';
import { IntervalWidgetBody } from './IntervalWidgetBody';
import { ChartShell } from '../ChartShell';

// The dashboard's dark-slate theme + the elec amber / gas blue tokens, shared via
// lib/chartTheme so the widget matches the surrounding charts.
const ELEC = FUEL_COLORS.ELECTRIC;
const GAS = FUEL_COLORS.GAS;
// (The unsettled-tail exclusion — AMI meters lag ~1–2 days, reporting the freshest
// hours as provisional 0s — now happens SERVER-SIDE in /api/interval/profile, so
// the widget no longer needs its own SETTLE_HOURS cutoff.)
const tooltipStyle = TOOLTIP_STYLE;
const axisStyle = AXIS_STYLE;

type Fuel = 'ELECTRIC' | 'GAS';
const FUELS: readonly Fuel[] = ['ELECTRIC', 'GAS'];
const FUEL_LABEL: Record<Fuel, string> = { ELECTRIC: 'Electric', GAS: 'Gas' };
const FUEL_UNIT: Record<Fuel, string> = { ELECTRIC: 'kWh', GAS: 'therms' };
// Peak demand is average POWER over the interval: kW for electric, therms/h for gas.
const POWER_UNIT: Record<Fuel, string> = { ELECTRIC: 'kW', GAS: 'therms/h' };

// Weekday-vs-weekend split (#77). Combined = one curve over all days (the original
// behavior); Weekday = Mon–Fri; Weekend = Sat/Sun.
type Split = 'COMBINED' | 'WEEKDAY' | 'WEEKEND';
const SPLITS: readonly Split[] = ['COMBINED', 'WEEKDAY', 'WEEKEND'];
const SPLIT_LABEL: Record<Split, string> = { COMBINED: 'Combined', WEEKDAY: 'Weekday', WEEKEND: 'Weekend' };

// Granularity (#77): the time-of-day bucket width fed to averageDayProfile. 60 is
// the default (robust across both fuels); 15 buckets electric finer. Gas is hourly
// at source so 15-min adds no detail there — the toggle is disabled for gas.
type Gran = '60' | '15';
const GRANS: readonly Gran[] = ['60', '15'];
const GRAN_LABEL: Record<Gran, string> = { '60': '1h', '15': '15m' };

// The settings panel rendered inside ChartShell's Customize popover / expand side.
// Mirrors ChartConfigMenu's row layout (uppercase label + a segmented control):
// Fuel, Days (weekday/weekend/combined split, #77) and Granularity (1h/15m, 15m
// disabled for gas which is hourly at source, #77).
function LoadShapeSettings({
  fuel,
  onFuel,
  split,
  onSplit,
  gran,
  onGran,
  granDisabled,
}: {
  fuel: Fuel;
  onFuel: (f: Fuel) => void;
  split: Split;
  onSplit: (s: Split) => void;
  gran: Gran;
  onGran: (g: Gran) => void;
  granDisabled: boolean;
}) {
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
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Days</div>
        <Segmented
          value={split}
          options={SPLITS.map((s) => ({ label: SPLIT_LABEL[s], value: s }))}
          onChange={onSplit}
        />
      </div>
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Granularity</div>
        <Segmented
          value={gran}
          options={GRANS.map((g) => ({ label: GRAN_LABEL[g], value: g }))}
          onChange={onGran}
          disabledValues={granDisabled ? new Set<Gran>(['15']) : undefined}
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
  const [split, setSplit] = useState<Split>('COMBINED');
  const [gran, setGran] = useState<Gran>('60');

  // Gas is hourly at source → no 15-min detail; disable the 15m granularity for
  // gas and fall the SHAPING back to 1h (the control snaps back below too).
  const granDisabled = fuel === 'GAS';
  const effectiveGran: Gran = granDisabled ? '60' : gran;

  // If the user picks 15m then switches to gas, snap the control back to 1h so it
  // doesn't show a greyed-out option as the selected one (mirrors IntervalHistory).
  useEffect(() => {
    if (fuel === 'GAS' && gran === '15') setGran('60');
  }, [fuel, gran]);

  // Fetch on mount + whenever the FUEL, the global RANGE, or the selected ACCOUNT
  // changes — NOT on the split/granularity toggles (the payload carries every
  // variant, so those switch instantly client-side). #150: the shared
  // useIntervalPayload hook owns the fetch lifecycle + stale-response guard; the
  // `validate` here keeps this widget's DISTINCT shape check + empty fallback (a
  // well-formed payload always carries the variants map; anything else → an empty
  // payload so the widget shows its empty state, not a crash). The server returns
  // the display-ready profiles (aggregated over the RAW rows); there is no
  // client-side shaping to redo.
  const acctQuery = accountId != null ? `&accountId=${accountId}` : '';
  const rangeQuery = from && to ? `&from=${from}&to=${to}` : '';
  const url = `/api/interval/profile?fuel=${fuel}${rangeQuery}${acctQuery}`;
  const { state, loading, errored } = useIntervalPayload<ProfilePayload>(url, (j) => {
    const p = j as ProfilePayload | null;
    if (p && p.variants && p.variants['60'] && p.variants['15']) return p;
    return {
      variants: {
        '60': { combined: [], weekday: [], weekend: [] },
        '15': { combined: [], weekday: [], weekend: [] },
      },
      peak: null,
    };
  });

  const color = fuel === 'GAS' ? GAS : ELEC;
  const unit = FUEL_UNIT[fuel];
  const powerUnit = POWER_UNIT[fuel];

  // Pick the right pre-computed profile from the server payload for the selected
  // split × granularity, then derive the stacked-area band fields: `base` = min (a
  // transparent floor) and `band` = max − min (the filled spread drawn ON TOP of
  // the floor via a shared stackId). Stacking two areas is the dependency-free way
  // to draw a min–max band in Recharts (it has no native band series). The
  // SHAPING (reconcile/grain/split/unsettled-tail cut) all happened SERVER-SIDE
  // over the RAW rows; here we just SELECT the matching variant — so a toggle is
  // an instant re-render with no refetch and no re-bucketing.
  const data = useMemo(() => {
    if (!state || 'error' in state) return [];
    const variant = state.variants[effectiveGran];
    let buckets: ProfileBucket[];
    if (split === 'COMBINED') buckets = variant.combined;
    else if (split === 'WEEKDAY') buckets = variant.weekday;
    else buckets = variant.weekend;

    return buckets.map((b) => ({
      ...b,
      base: b.min,
      band: b.max - b.min,
    }));
  }, [state, split, effectiveGran]);

  // Peak demand (#77): the highest average power over any single SETTLED interval
  // for this fuel — computed server-side over the RAW reads (finest grain wins; the
  // unsettled tail excluded). Independent of the day-split/granularity toggles.
  const peak = !state || 'error' in state ? null : state.peak;

  const empty = !loading && !errored && data.length === 0;

  // Peak-demand caption (#77): value + when, e.g. "Peak 4.21 kW · Sat, Jun 7 7 PM".
  // #150: the pure, hand-calc-tested formatPeakReadout (shaping out of the component).
  const peakReadout = formatPeakReadout(peak, powerUnit);

  // The chart body (render-prop for ChartShell): keeps the loading/empty/errored
  // states and the Recharts tree, just drawn into the height ChartShell supplies
  // (the grid cell at "100%" in the card, or "80vh" in the Expand modal). When
  // populated, a small peak-demand caption sits above the curve.
  const renderBody = (h: number | string) => (
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
        {peakReadout && (
          <div className="mb-1 shrink-0 text-xs text-slate-400">
            <span className="font-medium text-slate-200">{peakReadout}</span>
          </div>
        )}
        <div className="min-h-0 flex-1">
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
        </div>
        </>
    </IntervalWidgetBody>
  );

  return (
    <ChartShell
      title="Average daily load shape"
      subtitle={`Typical day · ${unit} · ${SPLIT_LABEL[split]}`}
      fill
      body={renderBody}
      settings={
        <LoadShapeSettings
          fuel={fuel}
          onFuel={setFuel}
          split={split}
          onSplit={setSplit}
          gran={effectiveGran}
          onGran={setGran}
          granDisabled={granDisabled}
        />
      }
    />
  );
}
