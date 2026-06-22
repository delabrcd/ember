// PURE query-param parsing shared by the interval routes (/api/interval +
// /api/interval/heatmap + /api/interval/profile). Factored out so the three
// routes parse `fuel`/`from`/`to`/`sinceDays` IDENTICALLY (the heatmap/profile
// routes take exactly the params the widgets already pass to /api/interval).
// NO React / DOM / DB / fetch dependency → hand-calc unit-testable.

import { BUCKET_LADDER_SECONDS } from './viz/chooseBucket';

export const DEFAULT_SINCE_DAYS = 30;
export const MIN_SINCE_DAYS = 1;
export const MAX_SINCE_DAYS = 400;

export function parseFuel(raw: string | null): 'ELECTRIC' | 'GAS' {
  return raw === 'GAS' ? 'GAS' : 'ELECTRIC';
}

// The number of seconds in the 15-minute grain — the only non-hourly grain the
// AMI feed produces (15-min electric NRT). Used both to query the DB filtered to
// 15-min rows and as the `?grain=15m` request value.
export const FIFTEEN_MIN_SECONDS = 900;

// The interval HISTORY widget's resolution grain. `'all'` (the default) returns
// every grain, downsampled to ≤ MAX_POINTS for the smooth multi-year line — the
// long-standing behaviour, kept for back-compat / non-dashboard callers. `'15m'`
// (issue: the 15m view was eating the downsampled feed and collapsing the recent
// 15-min sliver to a handful of points) returns ONLY the raw 900s rows for the
// window, UN-decimated — 15-min data is inherently recent/bounded (NRT, ~days), so
// serving it raw is cheap and avoids the spurious sparsity the time-bucket
// downsampler caused over a wide range. `'1h'` is the symmetric hourly path: it
// RECONCILES the raw rows to one value per hour (4 complete 15-min slots win, else
// the API hourly row) and THEN downsamples — the order matters, because doing it
// the other way (downsample the mixed feed, then reconcile on the client) silently
// drops every downsampled lone-15-min slot via reconcile's "partial 15-min, no
// hourly → skip" rule, capping the 1h line at the moment 15-min data begins.
export type IntervalGrain = 'all' | '15m' | '1h';

// Parse the `?grain=` param. An exact `'15m'` selects the raw-15-min path; `'1h'`
// selects the reconcile-then-downsample hourly path; anything else (absent,
// garbage) falls back to the default 'all' (all grains, downsampled). PURE.
export function parseGrain(raw: string | null): IntervalGrain {
  if (raw === '15m') return '15m';
  if (raw === '1h') return '1h';
  return 'all';
}

// WS8 OVERSCAN: an EXPLICIT bucket width (seconds) the caller can request so an
// OVERSCAN fetch is aggregated at the VIEW's grain, not the (wider) overscan
// span's grain. Background: WS8 preloads a superset wider than the visible window
// so a pan stays over real data; but if the route ran chooseBucket on that WIDER
// span it would pick a COARSER bucket than the view needs, and the visible slice
// would render at the wrong (too-coarse) resolution. So the client computes the
// bucket from the VIEW span (the same chooseBucket the server would use for the
// view) and passes it here; the route then aggregates the overscan [from,to] AT
// EXACTLY THAT BUCKET, keeping the visible portion grain-coherent.
//
// Validation: the value must be one of the chooseBucket ladder widths
// (BUCKET_LADDER_SECONDS) — a closed allowlist, so an arbitrary / malicious
// `?bucket=` can't drive the SQL bucket math to a junk value. Anything not on the
// ladder (absent, garbage, off-ladder seconds) → null = "server picks the bucket"
// (the unchanged pre-WS8 behaviour). PURE.
export function parseBucket(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const secs = Math.floor(n);
  return (BUCKET_LADDER_SECONDS as readonly number[]).includes(secs) ? secs : null;
}

// WS9 (Fix 3): decide the EFFECTIVE bucket the route should actually serve, given the
// REQUESTED bucket and the finest REAL grain present in the window. This guards the
// 15-min grid's hourly→15-min extrapolation so it only ever fires when the window
// genuinely contains 15-min data.
//
// Background: when bucketSecs == 900 the 15-min-grid path fabricates `hourly/4` flat
// quarter-steps for every hourly-only hour so the line doesn't cliff-end where 15-min
// recording began (the straddle case). But if the window is ENTIRELY in the hourly-only
// region (a deep-history view zoomed narrow), there are NO real 15-min rows and that
// path would produce an ALL-FAKE 15-min view of old hourly data. The operator only
// wants the extrapolation in the STRADDLE (real 15-min AND hourly-only present).
//
// The decision, keyed on the finest in-window grain (the min intervalSeconds present):
//   • requested != 900            → serve as requested (the SQL aggregate path; no grid).
//   • finestGrain == 900          → window HAS real 15-min rows (straddle or all-15-min)
//                                    → keep 900 (the grid; flats fill only the hourly-only
//                                    portion if any).
//   • finestGrain == null         → empty window → keep 900 (the grid returns []; nothing
//                                    to fabricate, and 900 keeps the empty-state grain stable).
//   • else (finestGrain > 900)    → NO real 15-min rows (entirely hourly-only) → FALL BACK
//                                    to hourly (3600), the finest REAL grain there, instead
//                                    of fabricating a 15-min grid of flats.
// Returns the effective bucket seconds; the route uses it for BOTH the path selection
// AND the response `grain` (so `grain` reflects what was actually served — 3600 in the
// fallback). PURE — no DB; the finestGrain probe is injected by the impure route.
export function resolveServedBucket(
  requestedBucketSecs: number,
  finestGrainInWindow: number | null
): number {
  if (requestedBucketSecs !== 900) return requestedBucketSecs;
  if (finestGrainInWindow === 900) return 900; // real 15-min present → grid
  if (finestGrainInWindow == null) return 900; // empty window → grid (returns [])
  return 3600; // hourly-only window → serve hourly, don't fabricate a 15-min grid
}

export function parseSinceDays(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SINCE_DAYS;
  return Math.min(MAX_SINCE_DAYS, Math.max(MIN_SINCE_DAYS, Math.floor(n)));
}

// Parse a YYYY-MM-DD param to a UTC Date, or null if absent/unparseable. `to` is
// widened to the END of its day (23:59:59.999 UTC) so an inclusive [from,to] day
// span captures every read on the last day.
export function parseDate(raw: string | null, endOfDay: boolean): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = endOfDay
    ? Date.UTC(y, mo - 1, d, 23, 59, 59, 999)
    : Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

// The resolved interval window the routes hand to getIntervalSeries: either a
// concrete [from, to] (the global-RangeControl path) OR a trailing sinceDays
// fallback. Mirrors the precedence /api/interval has always used: from/to WIN
// over sinceDays; inverted bounds are swapped.
export type IntervalWindow =
  | { from?: Date; to?: Date }
  | { sinceDays: number };

export function parseIntervalQuery(params: URLSearchParams): {
  fuelType: 'ELECTRIC' | 'GAS';
  window: IntervalWindow;
  grain: IntervalGrain;
  // WS8: an EXPLICIT, ladder-validated bucket width (seconds), or null when the
  // caller didn't request one (server picks the bucket — the pre-WS8 default). The
  // overscan client passes the VIEW-span bucket so the wider superset is aggregated
  // at the view's grain. See parseBucket.
  bucket: number | null;
} {
  const fuelType = parseFuel(params.get('fuel'));
  const grain = parseGrain(params.get('grain'));
  const bucket = parseBucket(params.get('bucket'));
  let from = parseDate(params.get('from'), false);
  let to = parseDate(params.get('to'), true);
  // If both bounds parsed but are inverted, swap so the query window is sane.
  if (from && to && from.getTime() > to.getTime()) {
    [from, to] = [to, from];
  }
  const hasWindow = !!(from || to);
  const window: IntervalWindow = hasWindow
    ? { from: from ?? undefined, to: to ?? undefined }
    : { sinceDays: parseSinceDays(params.get('sinceDays')) };
  return { fuelType, window, grain, bucket };
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Resolve a parsed IntervalWindow to a CONCRETE [from, to] pair so the history
// route can compute a span (→ chooseBucket) and a SQL range. `now` is injected (an
// epoch-ms instant) so this stays PURE + hand-calc unit-testable — the impure route
// passes Date.now().
//
// Rules (mirroring the precedence the route has always used):
//   • Both bounds present → use them as-is.
//   • Only `from` present → close the window at `now` (an open-ended "from X to
//     present" range).
//   • Only `to` present   → open the window DEFAULT_SINCE_DAYS before `to` (a
//     trailing window anchored at the explicit end).
//   • Neither (the sinceDays fallback) → [now − sinceDays·days, now].
// The returned bounds are always ordered (from ≤ to); a degenerate/inverted case
// collapses to a zero-width window at `to`, which chooseBucket handles (finest
// grain, ≤ 1 bucket). PURE.
export function resolveWindowBounds(window: IntervalWindow, now: number): { from: Date; to: Date } {
  if ('sinceDays' in window) {
    const days = window.sinceDays > 0 ? window.sinceDays : DEFAULT_SINCE_DAYS;
    return { from: new Date(now - days * DAY_MS), to: new Date(now) };
  }
  const toMs = window.to ? window.to.getTime() : now;
  const fromMs = window.from ? window.from.getTime() : toMs - DEFAULT_SINCE_DAYS * DAY_MS;
  // Order the bounds defensively (parseIntervalQuery already swaps inverted
  // explicit pairs, but a from-only/to-only mix could still cross here).
  const lo = Math.min(fromMs, toMs);
  const hi = Math.max(fromMs, toMs);
  return { from: new Date(lo), to: new Date(hi) };
}
