// PURE shaper for the IntervalHistory widget (issue #121 part 2). Maps raw
// smart-meter interval reads to time-series chart points — one point per row,
// with a formatted datetime label. NO React / DOM / DB / fetch dependency.
//
// APPROACH: unlike the load-shape widget (which AVERAGES across days), this
// widget shows the RAW historical timeline. The data flows directly from the
// API rows to chart points, keeping gaps as gaps (never fabricating zeros).

import type { IntervalProfileRow } from './intervalProfile';

// One chart point for the history time-series.
//   • ts       — UTC milliseconds (for ordering + numeric XAxis if needed).
//   • label    — human-readable datetime label (e.g. "Jun 8 14:00").
//   • value    — usage quantity (kWh or therms); never null (absent rows = absent points).
export type HistoryPoint = {
  ts: number;
  label: string;
  value: number;
};

// Format a UTC timestamp as a short human-readable datetime label in the
// America/New_York wall-clock. For a multi-day range we want "Jun 8 14:00";
// within a single day "14:00" suffices, but we always include the date so the
// label is unambiguous on a >24h axis. PURE.
const TZ = 'America/New_York';
const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// Format a UTC instant as "Jun 8 14:00" (short month, no leading zero on day,
// 24-h clock). Exported for unit-test access.
export function formatHistoryLabel(ts: number): string {
  // Intl.DateTimeFormat.formatToParts gives us the parts we need to build the
  // "Jun 8 14:00" label without brittle locale-specific string splitting.
  const parts = dateFmt.formatToParts(new Date(ts));
  let month = '';
  let day = '';
  let hour = '';
  let minute = '';
  for (const p of parts) {
    if (p.type === 'month') month = p.value;
    else if (p.type === 'day') day = p.value;
    else if (p.type === 'hour') hour = p.value;
    else if (p.type === 'minute') minute = p.value;
  }
  // Normalize "24" midnight to "00" (some Intl engines emit 24 for midnight
  // when hour12:false + 2-digit are combined).
  if (hour === '24') hour = '00';
  return `${month} ${day} ${hour}:${minute}`;
}

// Map raw interval rows to history chart points, sorted ascending by
// intervalStart. Drops rows with non-finite quantity or unparseable timestamp.
// DOES NOT fabricate zeros for gaps — absent rows = absent points (the caller
// renders with connectNulls=false so gaps appear as line breaks). PURE.
export function toHistoryPoints(rows: IntervalProfileRow[]): HistoryPoint[] {
  const points: HistoryPoint[] = [];
  for (const row of rows) {
    const q = Number(row.quantity);
    if (!Number.isFinite(q)) continue;
    const instant = row.intervalStart instanceof Date ? row.intervalStart : new Date(row.intervalStart as string);
    const ts = instant.getTime();
    if (!Number.isFinite(ts)) continue;
    points.push({ ts, label: formatHistoryLabel(ts), value: q });
  }
  // Sort ascending by timestamp (the API returns rows ordered by intervalStart,
  // but we sort defensively so the shaper is correct regardless of input order).
  points.sort((a, b) => a.ts - b.ts);
  return points;
}
