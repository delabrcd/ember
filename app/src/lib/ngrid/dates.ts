// Shared PURE date/format helpers for the scraper (no DB / Playwright / fs).
//
// These were duplicated across the impure scraper files (collect.ts, portalFetch.ts,
// interval.ts): the `YYYYMM` numeric key, the UTC `YYYY-MM-DD` formatter, the UTC
// `YYYY-MM-DD HH:MM:SS` portal formatter, and the day-in-ms constant. Consolidated
// here so a tweak can't drift between copies. Everything is byte-for-byte the same
// math the originals used — UTC fields throughout. Unit-tested (test/dates.test.ts).

export const DAY_MS = 24 * 60 * 60 * 1000;

const p2 = (n: number): string => String(n).padStart(2, '0');

// `YYYY-MM-DD` string → numeric `YYYYMM` (e.g. '2026-06-08' → 202606). A
// missing/non-matching input → 0. Matches the leading `^(\d{4})-(\d{2})` so an
// ISO timestamp ('2026-06-08T…') still keys correctly.
export function yyyymm(d?: string): number {
  if (!d) return 0;
  const m = d.match(/^(\d{4})-(\d{2})/);
  return m ? parseInt(m[1], 10) * 100 + parseInt(m[2], 10) : 0;
}

// Format a Date as `YYYY-MM-DD` using its UTC fields. (Was interval.ts's `fmtDate`
// and portalFetch.ts's `fmtGqlDate` — identical.)
export function fmtYmd(d: Date): string {
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

// Format a Date as the portal's `YYYY-MM-DD HH:MM:SS` using its UTC fields.
// (Was interval.ts's `fmtPortal`.)
export function fmtPortal(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ` +
    `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`
  );
}
