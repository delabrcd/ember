// PURE shaper for the interval load-shape widget (issue #76). Given raw
// smart-meter interval reads (ELECTRIC 15-min kWh / GAS hourly therms), it
// produces the AVERAGE DAY PROFILE — "what does a typical day look like?" — by
// bucketing every read by its LOCAL time-of-day and averaging within each bucket.
//
// This is the number layer for the widget: it has NO React / DOM / DB / fetch
// dependency, so it's hand-calc unit-tested in isolation (the same discipline
// series.ts / prediction.ts / intervalProfile's sibling aggregators follow). The
// component just fetches rows and feeds them here; all the arithmetic lives here.
//
// WHY HOURLY BUCKETS BY DEFAULT: an hourly bucket is robust across BOTH fuels —
// gas is already hourly (one read per bucket), and electric's four 15-minute reads
// in an hour fall into the same bucket and average to that hour's mean. So one
// shaper handles both without branching on the read cadence.

// One time-of-day bucket of the average-day profile.
//   • label   — the bucket's clock label ("HH:00", or "HH:MM" for sub-hour buckets).
//   • minutes — the bucket's START minute-of-day (0, 60, 120, … for hourly), used
//               for ordering and as a stable numeric key.
//   • mean    — the average `quantity` of all reads that fell in this bucket.
//   • min/max — the smallest/largest read in the bucket (the spread band).
//   • count   — how many reads contributed (4 for a full electric hour, 1 for gas).
export type ProfileBucket = {
  label: string;
  minutes: number;
  mean: number;
  min: number;
  max: number;
  count: number;
};

// One raw interval read the shaper consumes. `intervalStart` may be a Date or an
// ISO string (the API hands back Dates; a JSON round-trip yields strings) — both
// are tolerated. `intervalSeconds` is carried for completeness/symmetry with the
// DB row; the hourly-bucket shaping keys off the local clock time, not the read
// length, so the shaper does not currently weight by duration.
// `fuelType` is optional here so the base type stays lean; reconcileToHourly
// accepts a superset that carries it (ReconcileRow) and groups by (fuelType, hour).
export type IntervalProfileRow = {
  intervalStart: Date | string;
  intervalSeconds: number;
  quantity: number;
  fuelType?: string;
};

// Extended row type accepted by reconcileToHourly — a strict superset of
// IntervalProfileRow so averageDayProfile's signature is unchanged.
type ReconcileRow = IntervalProfileRow & { fuelType?: string };

export type AverageDayProfileOpts = {
  // The IANA timezone the time-of-day buckets are computed in. Defaults to the
  // account's region (Upstate NY) so a "typical day" reads in local clock time,
  // not UTC. Passed to Intl.DateTimeFormat, so it's deterministic given the tz.
  tz?: string;
  // Bucket width in minutes. 60 (hourly) by default — robust across 15-min
  // electric and hourly gas (see file header). Sub-hour values (e.g. 15) bucket
  // electric finer; must divide evenly into the day to tile it cleanly.
  bucketMinutes?: number;
  // Exclude reads at/after this instant from the average — the UNSETTLED TAIL.
  // AMI meters lag ~1–2 days and report the freshest hours as 0, then fill in, so
  // including them biases the "typical day" curve DOWN (~10%+ on a short window).
  // The widget passes `now − ~48h`; a typical-day profile doesn't need the last
  // couple of days anyway. Omitted = include all reads. PURE (caller supplies the
  // instant; the shaper stays clock-free).
  before?: Date;
};

const DEFAULT_TZ = 'America/New_York';
const DEFAULT_BUCKET_MINUTES = 60;
const MINUTES_PER_DAY = 24 * 60;

// Two-digit zero-pad for clock labels ("HH:MM"). PURE.
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// The LOCAL minute-of-day (0..1439) of a UTC instant in `tz`. We read the local
// hour + minute via Intl.DateTimeFormat (the only DOM-free, deterministic way to
// get a wall-clock time in an arbitrary IANA zone) and combine them. This is what
// lands a read in the right bucket across a DST shift or a UTC day boundary — e.g.
// 03:30 UTC on a -04:00 day is 23:30 the previous LOCAL day, hour 23. Returns null
// if the instant is unparseable. PURE (given tz).
function localMinuteOfDay(instant: Date, tz: string): number | null {
  const t = instant.getTime();
  if (!Number.isFinite(t)) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  });
  const parts = fmt.formatToParts(instant);
  let hour: number | null = null;
  let minute: number | null = null;
  for (const p of parts) {
    if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'minute') minute = Number(p.value);
  }
  if (hour == null || minute == null || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  // Intl emits "24" for midnight in the hour12:false 2-digit form in some engines;
  // normalize it to 0 so the bucket index stays in [0, MINUTES_PER_DAY).
  if (hour === 24) hour = 0;
  return hour * 60 + minute;
}

// The LOCAL hour-of-day (0..23) AND day-of-week (0=Sun..6=Sat) of a UTC instant
// in `tz`. Like localMinuteOfDay it reads the wall-clock via Intl.DateTimeFormat
// — the only DOM-free, deterministic way to resolve an arbitrary IANA zone — but
// also asks for the weekday so the day×hour heatmap and the weekday/weekend split
// decide the LOCAL day correctly across a UTC-day boundary or a DST shift (e.g.
// 03:30 UTC on a -04:00 day is 23:30 the PREVIOUS local day, so its weekday is
// that previous day's). Returns null if the instant is unparseable. PURE (given tz).
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};
function localHourAndDow(instant: Date, tz: string): { hour: number; dow: number } | null {
  const t = instant.getTime();
  if (!Number.isFinite(t)) return null;
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    hour: '2-digit',
    weekday: 'short',
  });
  const parts = fmt.formatToParts(instant);
  let hour: number | null = null;
  let dow: number | null = null;
  for (const p of parts) {
    if (p.type === 'hour') hour = Number(p.value);
    else if (p.type === 'weekday') dow = WEEKDAY_INDEX[p.value] ?? null;
  }
  if (hour == null || !Number.isFinite(hour) || dow == null) return null;
  // Intl emits "24" for midnight in the hour12:false 2-digit form in some engines;
  // normalize it to 0 so the hour stays in [0, 24).
  if (hour === 24) hour = 0;
  return { hour, dow };
}

// The clock label for a bucket whose start minute-of-day is `minutes`, at the
// given bucket width. Whole-hour buckets read "HH:00"; sub-hour buckets read the
// exact "HH:MM" start. PURE.
function bucketLabel(minutes: number, bucketMinutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (bucketMinutes >= 60 && m === 0) return `${pad2(h)}:00`;
  return `${pad2(h)}:${pad2(m)}`;
}

// Build the AVERAGE DAY PROFILE from raw interval reads. Each read is placed in
// its local time-of-day bucket (bucket index = floor(localMinuteOfDay /
// bucketMinutes)); within a bucket we average the quantities and track min/max +
// count. We emit only buckets that actually have data, in time order — never
// fabricating zero buckets for hours the meter didn't report (a quiet hour is
// genuinely absent, not zero usage). Tolerates string/Date `intervalStart` and
// drops reads whose quantity isn't finite or whose instant is unparseable. PURE.
export function averageDayProfile(
  rows: IntervalProfileRow[],
  opts: AverageDayProfileOpts = {}
): ProfileBucket[] {
  const tz = opts.tz ?? DEFAULT_TZ;
  const bucketMinutes =
    opts.bucketMinutes && opts.bucketMinutes > 0 ? Math.floor(opts.bucketMinutes) : DEFAULT_BUCKET_MINUTES;
  const bucketCount = Math.max(1, Math.ceil(MINUTES_PER_DAY / bucketMinutes));
  const beforeMs = opts.before instanceof Date && Number.isFinite(opts.before.getTime()) ? opts.before.getTime() : null;

  // Accumulator per bucket index: running sum/count + min/max, only materialized
  // for buckets that receive a read (so we can drop empty buckets at the end).
  type Acc = { sum: number; count: number; min: number; max: number };
  const accs = new Map<number, Acc>();

  for (const row of rows) {
    const q = Number(row.quantity);
    if (!Number.isFinite(q)) continue;
    const instant = row.intervalStart instanceof Date ? row.intervalStart : new Date(row.intervalStart);
    if (beforeMs != null && instant.getTime() >= beforeMs) continue; // drop the unsettled tail
    const mod = localMinuteOfDay(instant, tz);
    if (mod == null) continue;
    const idx = Math.min(bucketCount - 1, Math.floor(mod / bucketMinutes));
    const cur = accs.get(idx);
    if (cur) {
      cur.sum += q;
      cur.count += 1;
      if (q < cur.min) cur.min = q;
      if (q > cur.max) cur.max = q;
    } else {
      accs.set(idx, { sum: q, count: 1, min: q, max: q });
    }
  }

  // Emit populated buckets in time order (by bucket index → start minute).
  return [...accs.keys()]
    .sort((a, b) => a - b)
    .map((idx) => {
      const acc = accs.get(idx)!;
      const minutes = idx * bucketMinutes;
      return {
        label: bucketLabel(minutes, bucketMinutes),
        minutes,
        mean: acc.sum / acc.count,
        min: acc.min,
        max: acc.max,
        count: acc.count,
      };
    });
}

// ---------------------------------------------------------------------------
// reconcileToHourly — deduplicate dual-grain interval rows (issue #121)
// ---------------------------------------------------------------------------
// The DB may contain BOTH 15-min rows (intervalSeconds=900) AND hourly rows
// (intervalSeconds=3600) for the same fuel+hour. Feeding both grains straight
// to averageDayProfile would double-count because it treats every row as an
// independent reading. This helper collapses mixed-grain input to one row per
// (fuelType, UTC-hour) before handing off to the profiler.
//
// COLLAPSE RULES (non-destructive — we never delete/override either grain):
//   • EXACTLY four 900-s slots in the hour? → SUM them → one 3600-s row
//     (15-min wins: four complete slots are more accurate than the API hourly).
//   • An hourly (3600-s) row exists but 15-min is absent or incomplete? → use
//     the hourly row as-is.
//   • Partial 15-min (1–3 slots) and no hourly row? → SKIP that hour
//     (incomplete → would underreport usage).
//   • Never emit both grains for the same hour; never sum across grains.
//
// WHY UTC HOUR: America/New_York is always a whole-hour UTC offset, so the
// four 15-min slots of a local clock-hour all share the same UTC hour. Grouping
// by `Math.floor(utcMs / 3_600_000)` is therefore equivalent to grouping by the
// local clock-hour and is DST-safe.
//
// Input type is the same superset (ReconcileRow ⊇ IntervalProfileRow) so callers
// can pass widget rows (which carry fuelType) without a cast. Tolerates
// string/Date intervalStart and drops rows with non-finite quantity. Returns rows
// sorted ascending by intervalStart. PURE — no React/DOM/DB.
export function reconcileToHourly(rows: ReconcileRow[]): IntervalProfileRow[] {
  // Group by (fuelType, UTC-hour-epoch). The key is `"${fuelType}|${hourEpoch}"`.
  type Slot = { slot900: number[]; row3600: ReconcileRow | null; hourEpoch: number; fuelType: string };
  const groups = new Map<string, Slot>();

  for (const row of rows) {
    const q = Number(row.quantity);
    if (!Number.isFinite(q)) continue;
    const instant = row.intervalStart instanceof Date ? row.intervalStart : new Date(row.intervalStart as string);
    const t = instant.getTime();
    if (!Number.isFinite(t)) continue;

    const hourEpoch = Math.floor(t / 3_600_000); // UTC-hour bucket
    const fuel = row.fuelType ?? '';
    const key = `${fuel}|${hourEpoch}`;

    let g = groups.get(key);
    if (!g) {
      g = { slot900: [], row3600: null, hourEpoch, fuelType: fuel };
      groups.set(key, g);
    }

    if (row.intervalSeconds === 900) {
      g.slot900.push(q);
    } else if (row.intervalSeconds === 3600) {
      // Keep the first (or only) hourly row; duplicates shouldn't exist but if
      // they do, the first one wins (stable, deterministic).
      if (g.row3600 === null) g.row3600 = row;
    }
    // Any other intervalSeconds is ignored (future-proof).
  }

  const out: IntervalProfileRow[] = [];

  for (const g of groups.values()) {
    const hourStart = new Date(g.hourEpoch * 3_600_000);

    if (g.slot900.length === 4) {
      // Complete 15-min hour → sum the four slots (their sum equals the hour's usage).
      const quantity = g.slot900.reduce((acc, v) => acc + v, 0);
      out.push({ fuelType: g.fuelType, intervalStart: hourStart, intervalSeconds: 3600, quantity });
    } else if (g.row3600 !== null) {
      // No complete 15-min set → fall back to the hourly row.
      out.push({
        fuelType: g.fuelType,
        intervalStart: hourStart,
        intervalSeconds: 3600,
        quantity: Number(g.row3600.quantity),
      });
    }
    // else: partial 15-min slots + no hourly → skip (incomplete hour would underreport).
  }

  // Sort ascending by intervalStart so the profiler receives chronological input.
  out.sort((a, b) => (a.intervalStart as Date).getTime() - (b.intervalStart as Date).getTime());

  return out;
}

// ---------------------------------------------------------------------------
// weekdayWeekendProfiles — average-day profiles split by weekday vs weekend (#77)
// ---------------------------------------------------------------------------
// Partitions the input reads by their LOCAL day-of-week (in `opts.tz`, default
// America/New_York) into a WEEKDAY group (Mon–Fri) and a WEEKEND group (Sat/Sun),
// then runs the SAME pure averageDayProfile over each group independently. The
// result is two profiles you can overlay to compare a working day's shape against
// a weekend's. Each read lands in exactly one group based on its LOCAL day (the
// local-day decision reuses localHourAndDow's tz-aware weekday, so a UTC instant
// near midnight is attributed to the right local day across a DST shift). The
// `before` cutoff and `bucketMinutes` flow through to averageDayProfile unchanged
// (so the 15-min granularity toggle and the unsettled-tail exclusion apply to both
// groups identically). PURE — no React/DOM/DB.
export type WeekdayWeekendProfiles = {
  weekday: ProfileBucket[];
  weekend: ProfileBucket[];
};

export function weekdayWeekendProfiles(
  rows: IntervalProfileRow[],
  opts: AverageDayProfileOpts = {}
): WeekdayWeekendProfiles {
  const tz = opts.tz ?? DEFAULT_TZ;
  const weekday: IntervalProfileRow[] = [];
  const weekend: IntervalProfileRow[] = [];
  for (const row of rows) {
    const instant = row.intervalStart instanceof Date ? row.intervalStart : new Date(row.intervalStart);
    const ld = localHourAndDow(instant, tz);
    if (ld == null) continue; // unparseable instant → dropped (consistent with the profiler)
    // dow 0=Sun, 6=Sat → weekend; 1..5 → weekday.
    if (ld.dow === 0 || ld.dow === 6) weekend.push(row);
    else weekday.push(row);
  }
  // averageDayProfile applies the same tz/bucketMinutes/before to each group; an
  // empty group yields [] (the widget renders that curve as absent, not zero).
  return {
    weekday: averageDayProfile(weekday, opts),
    weekend: averageDayProfile(weekend, opts),
  };
}

// ---------------------------------------------------------------------------
// peakDemand — the highest average POWER over any interval, and when (#77)
// ---------------------------------------------------------------------------
// "Peak demand" is the maximum average power drawn over a single metered
// interval: quantity ÷ (intervalSeconds / 3600), i.e. the energy in the interval
// divided by its length in HOURS → kW (electric) or therms-per-hour (gas). A
// 15-min slot of 0.5 kWh therefore reads 0.5 / 0.25 = 2 kW; an hourly slot of
// 0.5 kWh reads 0.5 / 1 = 0.5 kW. Returns the peak value, the interval length it
// occurred over, and the (UTC) instant it started — or null if no row carries a
// finite quantity + positive interval length. The finest grain available wins
// naturally (a 15-min spike shows a higher kW than its hour's average), which is
// the point of a demand readout. Ties keep the EARLIEST occurrence (deterministic).
// PURE — no React/DOM/DB; the caller supplies the rows and formats the unit.
export type PeakDemand = {
  value: number; // average power over the interval (kW for electric, therms/h for gas)
  intervalStart: Date; // UTC start of the peak interval
  intervalSeconds: number; // the interval's length (900 / 3600 / …)
  quantity: number; // the raw energy reading that produced the peak
};

export function peakDemand(rows: IntervalProfileRow[]): PeakDemand | null {
  let best: PeakDemand | null = null;
  for (const row of rows) {
    const q = Number(row.quantity);
    const secs = Number(row.intervalSeconds);
    if (!Number.isFinite(q) || !Number.isFinite(secs) || secs <= 0) continue;
    const instant = row.intervalStart instanceof Date ? row.intervalStart : new Date(row.intervalStart);
    const t = instant.getTime();
    if (!Number.isFinite(t)) continue;
    const power = q / (secs / 3600); // energy ÷ hours = average power over the interval
    // Strictly-greater keeps the earliest on a tie (we iterate in input order, but
    // also compare timestamps so the result is order-independent on equal power).
    if (
      best === null ||
      power > best.value ||
      (power === best.value && t < best.intervalStart.getTime())
    ) {
      best = { value: power, intervalStart: new Date(t), intervalSeconds: secs, quantity: q };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// dayHourHeatmapRows — reshape reconciled hourly reads for the day×hour heatmap (#77)
// ---------------------------------------------------------------------------
// The existing pure aggregator dayHourHeatmap (lib/viz/aggregate.ts) + its
// renderer HeatmapViz (VizCharts.tsx) bin rows by integer (x, y) and AVERAGE the
// `value` field within each cell. To draw a DAY-OF-WEEK × HOUR-OF-DAY intensity
// grid we just need one row per reconciled hourly read carrying that read's local
// hour-of-day (x), local day-of-week (y), a display label for the day, and its
// usage as the value. The aggregator then averages every same-(dow, hour) read
// into the cell — exactly the "typical Monday 6pm vs typical Sunday 6pm" picture.
//
// FEED reconcileToHourly OUTPUT here (one row per hour, dual-grain collapsed) so a
// 15-min electric read doesn't count four times against its hour. Reads whose
// quantity isn't finite or whose instant is unparseable are dropped (never
// zero-filled — a missing hour leaves its cell empty in the renderer). PURE.
export type HeatmapRow = {
  hour: number; // local hour-of-day 0..23 (x bin)
  dow: number; // local day-of-week 0=Sun..6=Sat (y bin)
  dowLabel: string; // 'Sun'..'Sat' display label for the y axis
  value: number; // the hour's usage (kWh / therms)
};

const DOW_LABELS: readonly string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function dayHourHeatmapRows(
  rows: IntervalProfileRow[],
  opts: { tz?: string; before?: Date } = {}
): HeatmapRow[] {
  const tz = opts.tz ?? DEFAULT_TZ;
  const beforeMs =
    opts.before instanceof Date && Number.isFinite(opts.before.getTime()) ? opts.before.getTime() : null;
  const out: HeatmapRow[] = [];
  for (const row of rows) {
    const q = Number(row.quantity);
    if (!Number.isFinite(q)) continue;
    const instant = row.intervalStart instanceof Date ? row.intervalStart : new Date(row.intervalStart);
    const t = instant.getTime();
    if (!Number.isFinite(t)) continue;
    if (beforeMs != null && t >= beforeMs) continue; // drop the unsettled tail
    const ld = localHourAndDow(instant, tz);
    if (ld == null) continue;
    out.push({ hour: ld.hour, dow: ld.dow, dowLabel: DOW_LABELS[ld.dow], value: q });
  }
  return out;
}
