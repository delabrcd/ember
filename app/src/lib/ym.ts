// Canonical pure date/ym primitives — no DB, browser, or React. The whole app
// speaks two shapes; this is the single home for converting between them and a
// Date. Unit-tested in test/ym.test.ts.
//
//   - `ym`  — a year-month integer YYYYMM (MonthRow.ym, e.g. 202405).
//   - `ymd` — an ISO date string YYYY-MM-DD (Bill.statementDate).
//
// All Date conversions use UTC (getUTC*/toISOString) to match the rest of the
// pipeline — bill dates are stored/compared as UTC instants, never local time.

// Date → ym (YYYYMM), in UTC.
export const ymFromDate = (d: Date): number => d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);

// (year, 1-based month) → ym (YYYYMM).
export const ymFromParts = (year: number, month: number): number => year * 100 + month;

// Date → ISO date string (YYYY-MM-DD), in UTC. Matches `.toISOString().slice(0, 10)`.
export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

// ym → 'YYYY-MM' label, zero-padding the month (e.g. 202405 → "2024-05").
export const ymLabel = (ym: number): string => `${Math.floor(ym / 100)}-${String(ym % 100).padStart(2, '0')}`;

// Shift a ym by `delta` calendar months (delta may be negative), rolling across
// year boundaries. Converts to a 0-based absolute month index, shifts, converts
// back so the modular arithmetic stays correct for negative results.
export function ymAddMonths(ym: number, delta: number): number {
  const year = Math.floor(ym / 100);
  const month = ym % 100;
  const idx = year * 12 + (month - 1) + delta;
  const y = Math.floor(idx / 12);
  const mo = ((idx % 12) + 12) % 12;
  return y * 100 + (mo + 1);
}
