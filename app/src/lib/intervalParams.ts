// PURE query-param parsing shared by the interval routes (/api/interval +
// /api/interval/heatmap + /api/interval/profile). Factored out so the three
// routes parse `fuel`/`from`/`to`/`sinceDays` IDENTICALLY (the heatmap/profile
// routes take exactly the params the widgets already pass to /api/interval).
// NO React / DOM / DB / fetch dependency → hand-calc unit-testable.

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
// long-standing behaviour. `'15m'` (issue: the 15m view was eating the downsampled
// feed and collapsing the recent 15-min sliver to a handful of points) returns
// ONLY the raw 900s rows for the window, UN-decimated — 15-min data is inherently
// recent/bounded (NRT, ~days), so serving it raw is cheap and avoids the spurious
// sparsity the time-bucket downsampler caused over a wide range.
export type IntervalGrain = 'all' | '15m';

// Parse the `?grain=` param. Only an exact `'15m'` selects the raw-15-min path;
// anything else (absent, garbage, '1h') falls back to the default 'all' (all
// grains, downsampled). PURE.
export function parseGrain(raw: string | null): IntervalGrain {
  return raw === '15m' ? '15m' : 'all';
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
} {
  const fuelType = parseFuel(params.get('fuel'));
  const grain = parseGrain(params.get('grain'));
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
  return { fuelType, window, grain };
}
