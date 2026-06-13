// PURE display-ready aggregation for the interval HEATMAP + LOAD-SHAPE widgets
// (issue #77). This is the thin "build the display-ready aggregate from RAW rows"
// layer that the new /api/interval/heatmap and /api/interval/profile routes call:
// it composes the already-tested pure shapers (reconcileToHourly, dayHourHeatmap-
// Rows, averageDayProfile, weekdayWeekendProfiles, peakDemand from
// intervalProfile.ts + dayHourHeatmap / heatmapRowLabels from viz/aggregate.ts)
// into the exact JSON shapes the widgets render.
//
// WHY THIS EXISTS (the #77 bug): the widgets used to fetch /api/interval, which
// DOWNSAMPLES the rows to ≤600 points by absolute time for the history line. Run-
// ning hour-of-day / day-of-week binning or a peak over that time-decimated series
// merges adjacent hours (spurious "no data" heatmap cells) and decimates away
// 15-min demand spikes. The fix moves the aggregation SERVER-SIDE over the RAW,
// un-downsampled rows — so this helper takes the raw rows and returns small,
// display-ready payloads. The math is unchanged; only the data path is corrected.
//
// NO React / DOM / DB / fetch dependency (Prisma TYPES only via the row shapes it
// is handed) → hand-calc unit-tested in isolation (test/intervalAggregate.test.ts)
// like the sibling pure shapers. Display-only: never feeds /api/verify, the
// monthly series, or any billed-cost number.

import {
  averageDayProfile,
  dayHourHeatmapRows,
  peakDemand,
  reconcileToHourly,
  weekdayWeekendProfiles,
  type IntervalProfileRow,
  type ProfileBucket,
} from '@/lib/intervalProfile';
import { dayHourHeatmap, heatmapRowLabels, type HeatmapGrid } from '@/lib/viz/aggregate';

// The raw interval row this layer consumes — a strict superset of
// IntervalProfileRow that also carries fuelType (reconcileToHourly groups on it).
export type RawIntervalRow = IntervalProfileRow & { fuelType?: string };

// The day×hour heatmap encoding is fixed for this feed (the rows
// dayHourHeatmapRows emits): x = local hour, y = local day-of-week, value =
// usage, with a 'dowLabel' display label per row. Kept here so the route + its
// renderer agree on the field names without re-stating them.
const HEATMAP_ENCODING = {
  x: 'hour',
  y: 'dow',
  value: 'value',
  yLabelField: 'dowLabel',
} as const;

// The peak-demand readout shape, serialized for the wire (intervalStart as an ISO
// string so it survives JSON; the widget formats it in the account's local clock).
export type PeakDemandPayload = {
  value: number; // average power over the interval (kW elec / therms-per-h gas)
  intervalStart: string; // ISO-8601 UTC start of the peak interval
  intervalSeconds: number; // the peak interval's length (900 / 3600 / …)
  quantity: number; // the raw energy reading that produced the peak
};

// ---------------------------------------------------------------------------
// HEATMAP payload — the display-ready day×hour grid + row labels + peak.
// ---------------------------------------------------------------------------
// Built from the RAW rows: reconcile dual-grain → hourly (so a complete 15-min
// hour doesn't count four times), reshape to {hour, dow, value} rows, then run
// the existing dayHourHeatmap aggregator. The grid carries every (dow, hour) cell
// that truly has data with its mean, and a null cell where the meter reported
// nothing in that bin (NEVER a fabricated zero). `rowLabels` maps the y bin
// (0=Sun..6=Sat) → 'Sun'..'Sat'. Peak is over the RAW finest grain (15-min spikes
// win), not the reconciled hourly. `before` excludes the unsettled tail (applied
// to BOTH the grid and the peak) — the caller (an impure route) supplies it.
export type HeatmapPayload = {
  grid: HeatmapGrid;
  rowLabels: Record<number, string>;
  peak: PeakDemandPayload | null;
};

export function buildHeatmapPayload(
  rows: RawIntervalRow[],
  opts: { tz?: string; before?: Date } = {}
): HeatmapPayload {
  const heatRows = dayHourHeatmapRows(reconcileToHourly(rows), opts);
  const grid = dayHourHeatmap(heatRows, HEATMAP_ENCODING);
  const rowLabels = heatmapRowLabels(heatRows, HEATMAP_ENCODING);
  const peak = serializePeak(peakOfSettled(rows, opts.before));
  return { grid, rowLabels, peak };
}

// ---------------------------------------------------------------------------
// PROFILE payload — every average-day curve the load-shape widget toggles among,
// in ONE response so the split (combined/weekday/weekend) × granularity (1h/15m)
// toggles switch instantly client-side with NO refetch.
// ---------------------------------------------------------------------------
// At 1h we reconcile dual-grain input (a complete four-slot 15-min hour wins over
// its hourly counterpart — no double-count, no partial-hour underreport). At 15m
// we KEEP the raw 900-s reads (reconcileToHourly would collapse them, defeating
// the finer buckets). The `before` cutoff + bucketMinutes flow into the pure
// shapers unchanged. Each variant emits only populated buckets (a quiet hour is
// genuinely absent, never zero-filled). Peak is over the RAW finest grain.
export type ProfilePayload = {
  // bucketMinutes → split → buckets. e.g. variants['60'].combined, variants['15'].weekday.
  variants: Record<
    '60' | '15',
    { combined: ProfileBucket[]; weekday: ProfileBucket[]; weekend: ProfileBucket[] }
  >;
  peak: PeakDemandPayload | null;
};

export function buildProfilePayload(
  rows: RawIntervalRow[],
  opts: { tz?: string; before?: Date } = {}
): ProfilePayload {
  const hourly = reconcileToHourly(rows); // 1h grain: dual-grain collapsed
  const raw15 = rows.filter((r) => r.intervalSeconds === 900); // 15m grain: raw slots only

  const buildFor = (bucketMinutes: number) => {
    // Hourly source for 1h buckets, raw 15-min source for 15m buckets.
    const source: IntervalProfileRow[] = bucketMinutes === 60 ? hourly : raw15;
    const shaperOpts = { tz: opts.tz, before: opts.before, bucketMinutes };
    const ww = weekdayWeekendProfiles(source, shaperOpts);
    return {
      combined: averageDayProfile(source, shaperOpts),
      weekday: ww.weekday,
      weekend: ww.weekend,
    };
  };

  // The two granularities the load-shape widget offers (1h is robust across both
  // fuels; 15m buckets electric finer). Both are computed once so the widget's
  // granularity toggle is instant. A future width is a one-line add here + a
  // matching key in ProfilePayload['variants'].
  const variants: ProfilePayload['variants'] = {
    '60': buildFor(60),
    '15': buildFor(15),
  };

  return { variants, peak: serializePeak(peakOfSettled(rows, opts.before)) };
}

// ---------------------------------------------------------------------------
// Shared peak helpers (PURE).
// ---------------------------------------------------------------------------
// Peak demand over the RAW finest-grain rows, with the unsettled tail excluded:
// a lagged/partial fresh interval (AMI reports the freshest ~48h as 0 then fills)
// must not read as a false peak. We drop rows at/after `before` before peakDemand
// so the readout reflects only settled data. `before` omitted → all rows.
function peakOfSettled(rows: RawIntervalRow[], before?: Date) {
  const beforeMs =
    before instanceof Date && Number.isFinite(before.getTime()) ? before.getTime() : null;
  const settled =
    beforeMs == null
      ? rows
      : rows.filter((r) => {
          const t = (r.intervalStart instanceof Date ? r.intervalStart : new Date(r.intervalStart)).getTime();
          return Number.isFinite(t) && t < beforeMs;
        });
  return peakDemand(settled);
}

// Serialize a PeakDemand (Date intervalStart) to the wire payload (ISO string).
function serializePeak(peak: ReturnType<typeof peakDemand>): PeakDemandPayload | null {
  if (!peak) return null;
  return {
    value: peak.value,
    intervalStart: peak.intervalStart.toISOString(),
    intervalSeconds: peak.intervalSeconds,
    quantity: peak.quantity,
  };
}
