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
} {
  const fuelType = parseFuel(params.get('fuel'));
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
  return { fuelType, window };
}
