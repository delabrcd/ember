// Pure logic for smart-meter AMI interval usage ingest (issue #76).
//
// The portal exposes interval reads at a REST endpoint (NOT GraphQL):
//   GET /api/amiadapter-cu-uwp-sys/v1/interval/reads/{premise}/{servicePoint}
//       ?startDateTime=YYYY-MM-DD HH:MM:SS
//   → [ { startTime, endTime, value }, … ]   one object per interval
//
// Everything in this file is PURE (no DB / Playwright / fs) so the number and
// shape logic is unit-tested in isolation. The impure ingest (collect.ts) and
// upsert (persist.ts) call into these helpers. Per AGENTS.md rule #1, interval
// usage NEVER feeds billed-cost numbers — this is observational AMI data only.

// One parsed interval read, ready for the IntervalUsage upsert.
export type IntervalReadRow = {
  fuelType: string; // ELECTRIC | GAS (normalized)
  intervalStart: Date; // UTC instant the interval begins
  intervalSeconds: number; // 900 | 3600 | 86400 (endTime − startTime)
  quantity: number; // usage for the interval, in `unit`
  unit: string; // kWh | therms
  source: string; // 'portal'
};

// One raw read object as returned by the amiadapter endpoint.
export type RawIntervalRead = { startTime: string; endTime: string; value: number };

// Normalize the portal's fuel labels ("Gas", "ELECTRIC", "Electricity", …) to
// the ELECTRIC | GAS the rest of the app uses. Unknown labels pass through
// upper-cased so nothing is silently dropped.
export function normalizeFuel(raw: string): 'ELECTRIC' | 'GAS' | string {
  const s = String(raw ?? '').trim().toUpperCase();
  if (s.startsWith('ELEC')) return 'ELECTRIC';
  if (s.startsWith('GAS')) return 'GAS';
  return s;
}

// The display/storage unit for a fuel. Electric is kWh, gas is therms; anything
// else gets an empty unit (caller still stores the row).
export function unitForFuel(fuel: string): 'kWh' | 'therms' | '' {
  const f = normalizeFuel(fuel);
  if (f === 'ELECTRIC') return 'kWh';
  if (f === 'GAS') return 'therms';
  return '';
}

// Parse a batch of raw interval reads for ONE fuel into IntervalReadRows.
// - intervalStart = new Date(startTime): JS parses the ±HH:MM offset, yielding
//   the correct UTC instant (so DST fall-back's repeated 01:00 locals at -04:00
//   then -05:00 become two DISTINCT instants — both kept, no unique collision).
// - intervalSeconds = round((endTime − startTime) / 1000): granularity is
//   measured, never assumed (electric 15-min, gas may differ).
// Drops rows with a non-finite value, an unparseable/zero-length interval, or a
// bad start date. Sorts by intervalStart, then dedups by
// `start.getTime()+':'+seconds` keeping the LAST occurrence.
export function parseIntervalReads(
  raw: Array<{ startTime: string; endTime: string; value: number }>,
  fuelType: string,
  unit: string,
  source = 'portal'
): IntervalReadRow[] {
  const fuel = normalizeFuel(fuelType);
  const rows: IntervalReadRow[] = [];
  for (const r of Array.isArray(raw) ? raw : []) {
    const value = Number(r?.value);
    if (!Number.isFinite(value)) continue;
    const startMs = Date.parse(r?.startTime);
    const endMs = Date.parse(r?.endTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    const intervalSeconds = Math.round((endMs - startMs) / 1000);
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) continue;
    rows.push({
      fuelType: fuel,
      intervalStart: new Date(startMs),
      intervalSeconds,
      quantity: value,
      unit,
      source,
    });
  }
  rows.sort((a, b) => a.intervalStart.getTime() - b.intervalStart.getTime());
  // Dedup on the storage key (UTC instant + length); later rows win.
  const byKey = new Map<string, IntervalReadRow>();
  for (const row of rows) {
    byKey.set(`${row.intervalStart.getTime()}:${row.intervalSeconds}`, row);
  }
  return [...byKey.values()].sort((a, b) => a.intervalStart.getTime() - b.intervalStart.getTime());
}

// Pull the AMI-capable meter nodes out of the captured `billingAccount`.
// Shape: billingAccount.meter.nodes[] where each node has fuelType,
// servicePointNumber, optional meterNumber, optional meterPointNumber, and the
// per-meter AMI capability flag hasAmiSmartMeter. We GATE on
// hasAmiSmartMeter === true (issue #76) and require a servicePointNumber to
// build the URL. `meterPointNumber` (default '1' when absent) is needed for the
// gas gql variables. Tolerates any missing/garbage shape by returning [].
export function extractAmiMeters(
  billingAccount: unknown
): Array<{
  fuelType: string;
  servicePointNumber: string;
  meterNumber?: string;
  meterPointNumber: string;
}> {
  const ba = billingAccount as { meter?: { nodes?: unknown } } | null | undefined;
  const nodes = ba?.meter?.nodes;
  if (!Array.isArray(nodes)) return [];
  const out: Array<{
    fuelType: string;
    servicePointNumber: string;
    meterNumber?: string;
    meterPointNumber: string;
  }> = [];
  for (const n of nodes) {
    const node = n as {
      fuelType?: unknown;
      servicePointNumber?: unknown;
      meterNumber?: unknown;
      meterPointNumber?: unknown;
      hasAmiSmartMeter?: unknown;
    } | null;
    if (!node || node.hasAmiSmartMeter !== true) continue;
    if (node.servicePointNumber == null || node.servicePointNumber === '') continue;
    out.push({
      fuelType: normalizeFuel(String(node.fuelType ?? '')),
      servicePointNumber: String(node.servicePointNumber),
      meterNumber: node.meterNumber != null ? String(node.meterNumber) : undefined,
      meterPointNumber:
        node.meterPointNumber != null && node.meterPointNumber !== ''
          ? String(node.meterPointNumber)
          : '1',
    });
  }
  return out;
}

// Build the amiadapter interval-reads URL. The startDateTime is the portal's
// `YYYY-MM-DD HH:MM:SS` local-ish string; its space is encoded as %20.
export function amiIntervalUrl(
  base: string,
  premiseNumber: string,
  servicePointNumber: string,
  startDateTime: string
): string {
  const path = `/api/amiadapter-cu-uwp-sys/v1/interval/reads/${encodeURIComponent(
    premiseNumber
  )}/${encodeURIComponent(servicePointNumber)}`;
  const q = `startDateTime=${startDateTime.replace(/ /g, '%20')}`;
  return `${base.replace(/\/$/, '')}${path}?${q}`;
}

// Format a Date as the portal's `YYYY-MM-DD HH:MM:SS` (UTC fields). The endpoint
// is lenient about the exact wall-clock; we only need a floor far enough back to
// cover the requested window, and the upsert makes any overlap idempotent.
function fmtPortal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Decide the `startDateTime` to request for a meter:
//   1. explicit backfillFromIso (operator override) → use that date,
//   2. else a known lastStored instant → that minus a 1-day overlap (idempotent
//      catch-up; the upsert dedups the overlap),
//   3. else a default tail of `windowDays` before `now`.
// Returns the portal's `YYYY-MM-DD HH:MM:SS` string. PURE.
export function backfillStartFor(
  now: Date,
  lastStored: Date | null,
  backfillFromIso: string | undefined,
  windowDays: number
): string {
  if (backfillFromIso) {
    const t = Date.parse(backfillFromIso);
    if (Number.isFinite(t)) return fmtPortal(new Date(t));
  }
  if (lastStored) {
    return fmtPortal(new Date(lastStored.getTime() - DAY_MS));
  }
  return fmtPortal(new Date(now.getTime() - windowDays * DAY_MS));
}

// ---- GAS interval via the energy-usage GraphQL gateway (issue #76) ----------
//
// Gas has no REST amiadapter feed; instead the portal's "Energy Usage" view
// fires an `amiEnergyUsages` GraphQL query on the same `**-gql` gateway the
// scraper already replays for bills. The nodes come back HOURLY (one per
// 00:00, 01:00, …, 23:00) with `date` as the interval START (ISO-8601 with a
// TZ offset → a real UTC instant) and `quantity` as the usage (therms for gas).
// All the gql variables come from the AMI `meter` node we already capture plus
// the billingAccount's premiseNumber. Everything below is PURE.

// The exact GraphQL query string the portal sends (reverse-engineered).
export const AMI_ENERGY_USAGES_QUERY =
  'query NrtDailyUsage($meterNumber: String!, $premiseNumber: String!, $servicePointNumber: String!, $meterPointNumber: String!, $dateFrom: Date!, $dateTo: Date!) { amiEnergyUsages(meterNumber: $meterNumber, premiseNumber: $premiseNumber, servicePointNumber: $servicePointNumber, meterPointNumber: $meterPointNumber, dateFrom: $dateFrom, dateTo: $dateTo) { nodes { date fuelType quantity } } }';

// One raw node as returned by `amiEnergyUsages` (date = interval START).
export type RawAmiEnergyUsageNode = { date: string; fuelType?: string; quantity: number };

// Build the POST body for the amiEnergyUsages gql query. PURE.
// `dateFrom`/`dateTo` are `YYYY-MM-DD` strings (a date RANGE).
export function amiEnergyUsagesBody(
  meter: { meterNumber?: string; servicePointNumber: string; meterPointNumber: string },
  premiseNumber: string,
  dateFrom: string,
  dateTo: string
): { operationName: string; query: string; variables: Record<string, string> } {
  return {
    operationName: 'NrtDailyUsage',
    query: AMI_ENERGY_USAGES_QUERY,
    variables: {
      meterNumber: meter.meterNumber != null ? String(meter.meterNumber) : '',
      premiseNumber: String(premiseNumber),
      servicePointNumber: String(meter.servicePointNumber),
      meterPointNumber: String(meter.meterPointNumber),
      dateFrom,
      dateTo,
    },
  };
}

// Format a Date as the gql `YYYY-MM-DD` (UTC fields). PURE.
function fmtDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// Decide the [dateFrom, dateTo] window (YYYY-MM-DD) for a gas gql pull:
//   dateTo   = now,
//   dateFrom = explicit backfillFromIso override, else now − windowDays.
// PURE. The caller chunks a wide range into per-request spans (the server caps
// the range), advancing the window.
export function intervalDateWindow(
  now: Date,
  backfillFromIso: string | undefined,
  windowDays: number
): { dateFrom: string; dateTo: string } {
  const dateTo = fmtDate(now);
  if (backfillFromIso) {
    const t = Date.parse(backfillFromIso);
    if (Number.isFinite(t)) return { dateFrom: fmtDate(new Date(t)), dateTo };
  }
  return { dateFrom: fmtDate(new Date(now.getTime() - windowDays * DAY_MS)), dateTo };
}

// Parse a batch of `amiEnergyUsages` nodes for ONE fuel into IntervalReadRows.
// Unlike the REST reads, these nodes carry no endTime, so the interval LENGTH is
// INFERRED from the gap to the NEXT node (after sorting ascending by date):
//   intervalSeconds = round((next.date − cur.date) / 1000)
// The LAST node reuses the previous gap; a single node defaults to 3600 (hourly,
// the portal's grain). A computed gap that is ≤0 or absurd (> ~40 days) falls
// back to 3600. So hourly nodes → 3600 and a daily-spaced view → 86400.
// - intervalStart = new Date(date): JS parses the ±HH:MM offset → correct UTC.
// - quantity = node.quantity; unit = unitForFuel(fuel); drops non-finite qty /
//   unparseable dates. Dedup on `start.getTime()+':'+seconds`, keeping the LAST.
// PURE.
export function parseAmiEnergyUsages(
  nodes: Array<{ date: string; fuelType?: string; quantity: number }>,
  fuelType: string,
  source = 'portal'
): IntervalReadRow[] {
  const SANE_MAX_SECONDS = 40 * 24 * 60 * 60; // a gap bigger than this is a data hole.
  // First pass: keep only nodes with a parseable date + finite quantity.
  const parsed: Array<{ startMs: number; quantity: number; fuel: string }> = [];
  for (const n of Array.isArray(nodes) ? nodes : []) {
    const quantity = Number(n?.quantity);
    if (!Number.isFinite(quantity)) continue;
    const startMs = Date.parse(n?.date);
    if (!Number.isFinite(startMs)) continue;
    parsed.push({
      startMs,
      quantity,
      fuel: normalizeFuel(n?.fuelType || fuelType),
    });
  }
  parsed.sort((a, b) => a.startMs - b.startMs);
  const rows: IntervalReadRow[] = [];
  let prevGap = 3600;
  for (let i = 0; i < parsed.length; i++) {
    const cur = parsed[i];
    const next = parsed[i + 1];
    let intervalSeconds: number;
    if (next) {
      const gap = Math.round((next.startMs - cur.startMs) / 1000);
      intervalSeconds = gap > 0 && gap <= SANE_MAX_SECONDS ? gap : 3600;
    } else {
      // Last node: reuse the previous gap (or the 3600 default for a lone node).
      intervalSeconds = prevGap;
    }
    prevGap = intervalSeconds;
    rows.push({
      fuelType: cur.fuel,
      intervalStart: new Date(cur.startMs),
      intervalSeconds,
      quantity: cur.quantity,
      unit: unitForFuel(cur.fuel),
      source,
    });
  }
  // Dedup on the storage key (UTC instant + length); later rows win.
  const byKey = new Map<string, IntervalReadRow>();
  for (const row of rows) {
    byKey.set(`${row.intervalStart.getTime()}:${row.intervalSeconds}`, row);
  }
  return [...byKey.values()].sort((a, b) => a.intervalStart.getTime() - b.intervalStart.getTime());
}
