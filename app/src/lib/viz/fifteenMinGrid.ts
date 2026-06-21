// PURE 15-minute-grid shaper for the interval HISTORY feed (WS1 rework of #36).
//
// When the requested window is narrow enough that the chosen bucket width is the
// finest 900s grain (chooseBucket → 900), the widget wants a UNIFORM 15-minute
// line — one point every 15 min across the window — so the chart reads at the
// native resolution. The window is small here (≤ ~6 days → ≤ ~576 slots), so the
// impure route hydrates the raw 900s + 3600s rows for the window cheaply and hands
// them to this shaper; all the grid arithmetic lives here so it can be hand-calc
// unit-tested in isolation (test/fifteenMinGrid.test.ts).
//
// THE THREE REGIONS of a window, slot by slot:
//   1. Real 15-min data exists  → emit the real 900s reading.
//   2. NO 15-min for the hour but an hourly (3600s) row exists — the "hourly-only"
//      era OLDER than the 15-min archive (15-min electric is NRT-only ≤48h, deep
//      history is hourly GraphQL). We can't invent sub-hour structure we don't
//      have, but dropping the whole region would make the line cliff-end at the
//      moment 15-min recording began (the #143-class bug). So we emit FOUR EQUAL
//      quarter-steps of hourlyQuantity / 4: the grid stays uniform, the steps sit
//      at the SAME MAGNITUDE as real 15-min data (no vertical cliff), and the four
//      slots SUM EXACTLY to the hourly value (energy is conserved — asserted in a
//      test). It's a flat within-hour approximation, clearly a display-only fill.
//   3. Neither grain for the hour → GAP. We omit those slots entirely; the chart's
//      connectNulls=false renders the break. We NEVER fabricate zeros (standards
//      §1: a missing interval is absent, not zero usage).
//
// The output is the uniform-grid points in ascending time order, each carrying
// intervalSeconds=900 so downstream readers treat them as 15-min slots. Energy is
// conserved (real readings pass through untouched; hourly-only hours split into
// four equal quarters that re-sum to the hour). NO React / DOM / DB / fetch.

// The minimal row shape the shaper consumes — the raw IntervalUsage columns the
// route selects. `intervalStart` may be a Date (the Prisma row) or an ISO string
// (a JSON round-trip); both are tolerated.
export type GridInputRow = {
  intervalStart: Date | string;
  intervalSeconds: number;
  quantity: number;
  fuelType?: string;
  unit?: string;
};

// One 15-minute grid point the chart plots. Mirrors the IntervalUsage row shape
// (intervalStart + intervalSeconds + quantity + fuelType + unit) so it slots into
// the same /api/interval `rows` array the coarser SQL-aggregate path returns.
export type GridPoint = {
  intervalStart: Date;
  intervalSeconds: number; // always 900 here
  quantity: number;
  fuelType?: string;
  unit?: string;
};

const FIFTEEN_MIN_MS = 15 * 60_000;
const HOUR_MS = 60 * 60_000;

// Parse a row's intervalStart (Date or ISO string) to epoch ms, or null if
// unparseable. PURE. (Named `rowStartMs` to avoid shadowing the `toMs` parameter
// of toFifteenMinGrid.)
function rowStartMs(start: Date | string): number | null {
  const t = start instanceof Date ? start.getTime() : new Date(start).getTime();
  return Number.isFinite(t) ? t : null;
}

// Build the uniform 15-minute grid for [fromMs, toMs] from the raw 900s + 3600s
// rows the route fetched. Walks every 15-min slot start in the window (inclusive
// of fromMs, slots strictly before toMs) and resolves it against the three regions
// above. `fuelType`/`unit` on emitted points are carried from whichever source row
// supplied the slot (real 900s row → its own; hourly-only → the hour's 3600s row).
//
// Rows with a non-finite quantity or unparseable instant are ignored when indexing
// (consistent with the sibling shapers). PURE.
export function toFifteenMinGrid(rows: GridInputRow[], fromMs: number, toMs: number): GridPoint[] {
  const out: GridPoint[] = [];
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return out;

  // Index the raw rows by grain:
  //   slot900  — a map slot-start-ms → the real 15-min row at that slot.
  //   hour3600 — a map hour-start-ms → the hourly row covering that hour.
  // Both keyed on the UTC epoch so an exact slot/hour lookup is O(1) per grid step.
  const slot900 = new Map<number, GridInputRow>();
  const hour3600 = new Map<number, GridInputRow>();
  for (const row of rows) {
    const q = Number(row.quantity);
    if (!Number.isFinite(q)) continue;
    const ms = rowStartMs(row.intervalStart);
    if (ms == null) continue;
    if (row.intervalSeconds === 900) {
      // First write wins (duplicates shouldn't exist on the unique grain key).
      if (!slot900.has(ms)) slot900.set(ms, row);
    } else if (row.intervalSeconds === 3600) {
      const hourStart = Math.floor(ms / HOUR_MS) * HOUR_MS;
      if (!hour3600.has(hourStart)) hour3600.set(hourStart, row);
    }
    // Other grains (e.g. daily 86400) don't belong on a 15-min grid → ignored.
  }

  // Snap the window start DOWN to its 15-min slot boundary so the grid is aligned
  // to clean :00/:15/:30/:45 marks regardless of the caller's exact fromMs.
  const firstSlot = Math.floor(fromMs / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;

  for (let slot = firstSlot; slot < toMs; slot += FIFTEEN_MIN_MS) {
    // Region 1: a real 15-min reading for this exact slot → pass it through.
    const real = slot900.get(slot);
    if (real) {
      out.push({
        intervalStart: new Date(slot),
        intervalSeconds: 900,
        quantity: Number(real.quantity),
        fuelType: real.fuelType,
        unit: real.unit,
      });
      continue;
    }
    // Region 2: no 15-min, but an hourly row covers this slot's hour → emit one of
    // the four equal quarter-steps (hourlyQuantity / 4). The four slots of the hour
    // each get the same value, so they SUM back to the hourly quantity.
    const hourStart = Math.floor(slot / HOUR_MS) * HOUR_MS;
    const hourly = hour3600.get(hourStart);
    if (hourly) {
      out.push({
        intervalStart: new Date(slot),
        intervalSeconds: 900,
        quantity: Number(hourly.quantity) / 4,
        fuelType: hourly.fuelType,
        unit: hourly.unit,
      });
      continue;
    }
    // Region 3: neither grain → GAP. Omit the slot (connectNulls=false breaks the
    // line); never fabricate a zero.
  }

  return out;
}
