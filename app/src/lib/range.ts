// Pure date-range model + resolution — no DB, browser, or React. Drives every
// chart, the bills list and the CSV/PDF export scoping from a single persisted
// pref (lib/prefs.tsx). Unit-tested in test/range.test.ts.
//
// Two key shapes the rest of the app speaks:
//   - `ym`  — a year-month integer YYYYMM (MonthRow.ym, e.g. 202405).
//   - `ymd` — an ISO date string YYYY-MM-DD (Bill.statementDate).
// resolveRange normalises a RangePref into concrete inclusive `ym` bounds so a
// caller can filter either shape with a single comparison.

export type RangePreset = 'all' | 'ytd' | '12mo' | '24mo' | '36mo' | 'custom';

export interface RangePref {
  preset: RangePreset;
  // Only meaningful for preset === 'custom'. Inclusive `ym` bounds (YYYYMM).
  // null = open-ended on that side (falls back to the data's natural edge).
  fromYm: number | null;
  toYm: number | null;
}

export interface ResolvedRange {
  fromYm: number;
  toYm: number;
}

export const DEFAULT_RANGE: RangePref = { preset: 'all', fromYm: null, toYm: null };

// The non-custom presets the UI offers, with their trailing-month window. `all`
// and `ytd` are special-cased in resolveRange; the rest are a fixed month count.
export const RANGE_PRESETS: { value: Exclude<RangePreset, 'custom'>; label: string; months?: number }[] = [
  { value: 'all', label: 'All' },
  { value: 'ytd', label: 'YTD' },
  { value: '12mo', label: '12 mo', months: 12 },
  { value: '24mo', label: '24 mo', months: 24 },
  { value: '36mo', label: '36 mo', months: 36 },
];

const MONTHS_BY_PRESET: Record<string, number> = { '12mo': 12, '24mo': 24, '36mo': 36 };

// ── ym <-> (year, month) helpers ────────────────────────────────────────────

export const ymOfDate = (d: Date): number => d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);

// Parse a YYYY-MM-DD (or YYYY-MM) string to a YYYYMM integer. Returns null for
// anything unparseable so callers can treat bad input as "no bound".
export function ymdToYm(ymd: string | null | undefined): number | null {
  if (!ymd) return null;
  const m = /^(\d{4})-(\d{2})/.exec(ymd);
  if (!m) return null;
  return Number(m[1]) * 100 + Number(m[2]);
}

// First day of a ym as an ISO date string (YYYY-MM-01). Handy for <input type=date>.
export function ymToYmd(ym: number | null | undefined): string {
  if (ym == null) return '';
  return `${Math.floor(ym / 100)}-${String(ym % 100).padStart(2, '0')}-01`;
}

// Last day of a ym as an ISO date string (YYYY-MM-DD). Used to widen a ym range
// to a full-month [first, last] date span for date-based scoping (e.g. PDF export).
export function ymToLastYmd(ym: number | null | undefined): string {
  if (ym == null) return '';
  const year = Math.floor(ym / 100);
  const month = ym % 100;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate(); // day 0 of next month = last of this
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

// Subtract `n - 1` months from a ym so that a window of `n` months *ending* at
// `ym` includes `ym` itself (a 12-month window ending 202412 starts 202401).
export function ymMinusMonths(ym: number, n: number): number {
  const year = Math.floor(ym / 100);
  const month = ym % 100;
  // Convert to a 0-based absolute month index, shift, convert back.
  const idx = year * 12 + (month - 1) - n;
  const y = Math.floor(idx / 12);
  const mo = (idx % 12 + 12) % 12;
  return y * 100 + (mo + 1);
}

// ── visual month/year picker helpers (issue #39) ────────────────────────────
// Pure building blocks for the RangeControl popover (12-month grid, year nav,
// clamping/disabling, labels, from/to swap). No DB/browser/React. Tested in
// test/monthPicker.test.ts.

const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

// Compose a ym integer from a year and a 1-based month. PURE.
export const ymOf = (year: number, month: number): number => year * 100 + month;

// Split a ym back into { year, month } (month 1-based). PURE.
export function ymParts(ym: number): { year: number; month: number } {
  return { year: Math.floor(ym / 100), month: ym % 100 };
}

// The twelve months of a calendar year as pickable cells. PURE — the popover
// maps these to buttons. `label` is the short month name; `ym` is YYYYMM.
export function monthGrid(year: number): { month: number; label: string; ym: number }[] {
  return MONTH_LABELS.map((label, i) => ({ month: i + 1, label, ym: ymOf(year, i + 1) }));
}

// Clamp a ym into the inclusive [minYm, maxYm] data window. Either bound may be
// null/undefined to leave that side open. PURE.
export function clampYm(ym: number, minYm: number | null | undefined, maxYm: number | null | undefined): number {
  let out = ym;
  if (minYm != null && out < minYm) out = minYm;
  if (maxYm != null && out > maxYm) out = maxYm;
  return out;
}

// A human label for a ym, e.g. 202405 → "May 2024". PURE — used on the picker
// trigger button and the from/to headers.
export function ymToLabel(ym: number | null | undefined): string {
  if (ym == null) return '—';
  const { year, month } = ymParts(ym);
  const name = MONTH_LABELS[month - 1] ?? '??';
  return `${name} ${year}`;
}

// True when a month falls outside the data window and so should be greyed/disabled
// in the grid. Open bounds (null) never disable that side. PURE.
export function isMonthDisabled(ym: number, minYm: number | null | undefined, maxYm: number | null | undefined): boolean {
  if (minYm != null && ym < minYm) return true;
  if (maxYm != null && ym > maxYm) return true;
  return false;
}

// Normalise a (from, to) pair so from ≤ to, swapping if the user picked them out
// of order. PURE — mirrors resolveRange's custom-range swap so the picker and the
// resolver agree. Returns a fresh tuple.
export function normalizeFromTo(fromYm: number, toYm: number): { fromYm: number; toYm: number } {
  return fromYm <= toYm ? { fromYm, toYm } : { fromYm: toYm, toYm: fromYm };
}

// ── resolution ──────────────────────────────────────────────────────────────

// Resolve a RangePref against the data's natural span into concrete inclusive
// `ym` bounds. PURE.
//
// - `allYms`  — every ym present in the data (any order; empties tolerated).
// - `nowYm`   — "today" as YYYYMM, used by the trailing presets and YTD so the
//               window is anchored to the calendar, not just the last data point.
//
// Edge cases, all hand-tested:
//   * empty data → a degenerate [nowYm, nowYm] range (nothing matches anyway).
//   * a trailing/ytd window that starts before the first data point is clamped
//     to the data's first ym so the lower bound is never wider than the data.
//   * 'custom' with a null side falls back to the data edge on that side; an
//     inverted custom range (from > to) is normalised by swapping.
export function resolveRange(range: RangePref, allYms: number[], nowYm: number): ResolvedRange {
  const yms = allYms.filter((y) => Number.isFinite(y));
  const dataFrom = yms.length ? Math.min(...yms) : nowYm;
  const dataTo = yms.length ? Math.max(...yms) : nowYm;

  // Anchor the trailing/ytd windows to the later of "now" and the last data
  // point so a stale clock (or future-dated data) still shows the newest bills.
  const anchorTo = Math.max(nowYm, dataTo);

  switch (range.preset) {
    case 'all':
      return { fromYm: dataFrom, toYm: dataTo };
    case 'ytd': {
      const jan = Math.floor(anchorTo / 100) * 100 + 1;
      return { fromYm: Math.max(jan, dataFrom), toYm: dataTo };
    }
    case '12mo':
    case '24mo':
    case '36mo': {
      const months = MONTHS_BY_PRESET[range.preset];
      const start = ymMinusMonths(anchorTo, months - 1);
      return { fromYm: Math.max(start, dataFrom), toYm: dataTo };
    }
    case 'custom': {
      let from = range.fromYm ?? dataFrom;
      let to = range.toYm ?? dataTo;
      if (from > to) [from, to] = [to, from];
      return { fromYm: from, toYm: to };
    }
    default:
      return { fromYm: dataFrom, toYm: dataTo };
  }
}

// Filter a row list (anything with a numeric `ym`) to a resolved range. PURE.
export function filterByYm<T extends { ym: number }>(rows: T[], r: ResolvedRange): T[] {
  return rows.filter((row) => row.ym >= r.fromYm && row.ym <= r.toYm);
}

// Filter a bill list (anything with a `statementDate` ISO string) to a resolved
// range, comparing on the statement month. PURE.
export function filterBillsByYm<T extends { statementDate: string }>(bills: T[], r: ResolvedRange): T[] {
  return bills.filter((b) => {
    const ym = ymdToYm(b.statementDate);
    return ym != null && ym >= r.fromYm && ym <= r.toYm;
  });
}

// ── migration from the legacy rangeMonths pref ──────────────────────────────

// Map a stale `rangeMonths` number (0 = all, 12/24/36 = trailing window) to the
// new RangePref model so a returning user keeps their selection. Unknown values
// default to "all". PURE.
export function migrateRangeMonths(rangeMonths: number | null | undefined): RangePref {
  switch (rangeMonths) {
    case 12:
      return { preset: '12mo', fromYm: null, toYm: null };
    case 24:
      return { preset: '24mo', fromYm: null, toYm: null };
    case 36:
      return { preset: '36mo', fromYm: null, toYm: null };
    case 0:
    default:
      return { ...DEFAULT_RANGE };
  }
}
