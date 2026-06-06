// Pure CSV builders — no DB, browser, or React. The export route (api/export)
// and its unit tests (test/csv.test.ts) are the only consumers. Cost columns
// reuse the already-correct sourcing from queries.ts/series.ts (the bill PDF's
// current charges, NOT the API amount due) — see docs/Data-Accuracy. No new
// cost math lives here.
import type { MonthRow } from './chartSpec';

type Cell = string | number | null | undefined;

// RFC-4180-ish field quoting: a field that contains a comma, double-quote, CR or
// LF is wrapped in double-quotes with any internal quote doubled. null/undefined
// render as the empty string; numbers are emitted as-is.
function field(v: Cell): string {
  if (v == null) return '';
  const s = typeof v === 'number' ? String(v) : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Join headers + rows into a CRLF-delimited CSV string. Pure.
export function toCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(field).join(','));
  return lines.join('\r\n');
}

// Monthly series → CSV. Column order is fixed (see issue #3). `currentCharges`
// is MonthRow.billTotal — the period energy cost the pipeline already sources
// from the bill PDF's current charges, not the API amount due.
export function seriesToCsv(rows: MonthRow[]): string {
  const headers = [
    'month',
    'kWh',
    'therms',
    'elecSupply',
    'gasSupply',
    'elecDelivery',
    'gasDelivery',
    'currentCharges',
    'elecRateSupply',
    'gasRateSupply',
    'elecRateAllIn',
    'gasRateAllIn',
    'avgTemp',
    'hdd',
    'cdd',
  ];
  const body: Cell[][] = rows.map((r) => [
    r.label,
    r.kwh,
    r.therms,
    r.elecSupply,
    r.gasSupply,
    r.elecDelivery,
    r.gasDelivery,
    r.billTotal,
    r.elecRateSupply,
    r.gasRateSupply,
    r.elecRateAllIn,
    r.gasRateAllIn,
    r.avgTemp,
    r.hdd,
    r.cdd,
  ]);
  return toCsv(headers, body);
}

// Shape of the bill rows getBills() hands back. `currentCharges` is already the
// period energy charges (currentCharges ?? totalDueAmount); `amountDue` is the
// statement amount due (with any carryover).
export interface BillCsvRow {
  statementDate: string;
  periodFrom: string | null;
  periodTo: string | null;
  totalDueAmount: number | null; // labelled currentCharges in the CSV
  amountDue: number | null;
  hasPdf: boolean;
}

// Bills list → CSV. currentCharges is the bills' period energy cost (the
// totalDueAmount field getBills maps to currentCharges ?? totalDueAmount).
export function billsToCsv(bills: BillCsvRow[]): string {
  const headers = ['statementDate', 'periodFrom', 'periodTo', 'currentCharges', 'amountDue', 'hasPdf'];
  const body: Cell[][] = bills.map((b) => [
    b.statementDate,
    b.periodFrom,
    b.periodTo,
    b.totalDueAmount,
    b.amountDue,
    String(b.hasPdf),
  ]);
  return toCsv(headers, body);
}
