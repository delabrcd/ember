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
import {
  averageDayProfile,
  peakDemand,
  reconcileToHourly,
  weekdayWeekendProfiles,
  type IntervalProfileRow,
  type ProfileBucket,
} from '@/lib/intervalProfile';
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

// Format the peak-demand instant in the account's local clock as "Mon, Jun 8 6 PM".
const peakFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  hour12: true,
});

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
  disabledValues,
}: {
  value: T;
  options: { label: string; value: T }[];
  onChange: (v: T) => void;
  disabledValues?: Set<T>;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
      {options.map((o) => {
        const disabled = disabledValues?.has(o.value) ?? false;
        return (
          <button
            key={o.value}
            onClick={() => !disabled && onChange(o.value)}
            disabled={disabled}
            className={`px-2.5 py-1 text-xs transition ${
              value === o.value
                ? 'bg-amber-500 text-slate-950'
                : disabled
                  ? 'cursor-not-allowed bg-slate-800/50 text-slate-600'
                  : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

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
        <LabelledSegmented
          value={fuel}
          options={FUELS.map((f) => ({ label: FUEL_LABEL[f], value: f }))}
          onChange={onFuel}
        />
      </div>
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Days</div>
        <LabelledSegmented
          value={split}
          options={SPLITS.map((s) => ({ label: SPLIT_LABEL[s], value: s }))}
          onChange={onSplit}
        />
      </div>
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Granularity</div>
        <LabelledSegmented
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
  const [state, setState] = useState<LoadState>(undefined);

  // Gas is hourly at source → no 15-min detail; disable the 15m granularity for
  // gas and fall the SHAPING back to 1h (the control snaps back below too).
  const granDisabled = fuel === 'GAS';
  const effectiveGran: Gran = granDisabled ? '60' : gran;

  // If the user picks 15m then switches to gas, snap the control back to 1h so it
  // doesn't show a greyed-out option as the selected one (mirrors IntervalHistory).
  useEffect(() => {
    if (fuel === 'GAS' && gran === '15') setGran('60');
  }, [fuel, gran]);

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
  const powerUnit = POWER_UNIT[fuel];

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
    const bucketMinutes = Number(effectiveGran);
    // GRAIN: at 1h we reconcile dual-grain input (15-min + hourly may coexist for
    // ELECTRIC) so a complete four-slot 15-min hour wins over its hourly counterpart
    // (no double-count, no partial-hour underreport). At 15m we must KEEP the raw
    // 15-min reads (reconcileToHourly would collapse them, defeating the finer
    // buckets) — so we feed the raw 900-s rows straight through. The `before` cutoff
    // is applied by averageDayProfile/weekday-weekend (order: reconcile → then cut).
    const shaped: IntervalProfileRow[] =
      effectiveGran === '15' ? state.rows.filter((r) => r.intervalSeconds === 900) : reconcileToHourly(state.rows);

    // Build the profile(s) for the selected day split. Combined = one profile over
    // all days; weekday/weekend = the matching partition (PURE splitter).
    let buckets: ProfileBucket[];
    if (split === 'COMBINED') {
      buckets = averageDayProfile(shaped, { before, bucketMinutes });
    } else {
      const { weekday, weekend } = weekdayWeekendProfiles(shaped, { before, bucketMinutes });
      buckets = split === 'WEEKDAY' ? weekday : weekend;
    }

    return buckets.map((b) => ({
      ...b,
      base: b.min,
      band: b.max - b.min,
    }));
  }, [state, split, effectiveGran]);

  // Peak demand (#77): the highest average power over any single SETTLED interval
  // for this fuel, from the RAW reads (finest grain wins — a 15-min spike reads a
  // higher kW than its hour's mean). Independent of the day-split toggle (it's a
  // single extreme, not an average). Excludes the unsettled tail so a lagged/partial
  // fresh interval can't read as a false peak.
  const peak = useMemo(() => {
    if (!state || 'error' in state) return null;
    const beforeMs = Date.now() - SETTLE_HOURS * 3600_000;
    const settled = state.rows.filter((r) => {
      const t = (r.intervalStart instanceof Date ? r.intervalStart : new Date(r.intervalStart)).getTime();
      return Number.isFinite(t) && t < beforeMs;
    });
    return peakDemand(settled);
  }, [state]);

  const loading = state === undefined;
  const errored = !!state && 'error' in state;
  const empty = !loading && !errored && data.length === 0;

  // Peak-demand caption (#77): value + when, e.g. "Peak 4.21 kW · Sat, Jun 7 7 PM".
  const peakReadout = peak
    ? `Peak ${peak.value.toFixed(peak.value < 10 ? 2 : 1)} ${powerUnit} · ${peakFmt.format(peak.intervalStart)}`
    : null;

  // The chart body (render-prop for ChartShell): keeps the loading/empty/errored
  // states and the Recharts tree, just drawn into the height ChartShell supplies
  // (the grid cell at "100%" in the card, or "80vh" in the Expand modal). When
  // populated, a small peak-demand caption sits above the curve.
  const renderBody = (h: number | string) => (
    <div style={{ height: h }} className="flex w-full flex-col">
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
      )}
      </div>
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
