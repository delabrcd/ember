// In-app notifications model (notifications-dropdown feature).
//
// The dashboard's header bell surfaces, in-app, the SAME events the email /
// webhook / ntfy channels already send on scheduled scrapes: usage/cost
// ANOMALIES (#45) and NEW-BILL alerts (#7). This module is the PURE derivation —
// it takes the already-computed Overview (anomaly flags + the latest bill) and the
// set of locally-dismissed keys, and returns the ordered, de-dismissed list the
// bell renders. No DB / network / React here; the arithmetic-free transform is
// hand-tested in notifications.test.ts.
//
// STABLE KEYS. Each notification carries a key that's stable across reloads so a
// dismissal sticks (it's persisted in prefs, localStorage):
//   anomaly  -> `anomaly:{ym}:{fuel}:{metric}`   (one per flag)
//   new-bill -> `bill:{statementDate}`           (one for the latest bill only)
// A dismissed key never reappears; the unread badge counts only what survives the
// filter here.

import type { AnomalyResult, AnomalyFlag } from './anomaly';
import { rate, num } from './format';

// The slice of Overview this module reads. Kept narrow (and structurally
// compatible with useDashboardData's Overview) so the helper stays decoupled from
// the full fetch shape and trivially testable.
export interface NotificationsOverview {
  anomalies?: AnomalyResult | null;
  latestBill?: { statementDate: string; totalDueAmount: number | null } | null;
}

export type NotificationKind = 'anomaly' | 'bill';
export type NotificationTone = 'warning' | 'info';

// The latest-bill source carried on a 'bill' notification so the detail modal can
// render the summary without re-deriving it. Structurally a subset of Overview's
// latestBill (statement + the period's Amount Due) — kept here so the click-detail
// view has everything it needs straight off the notification.
export interface NotificationBill {
  statementDate: string;
  totalDueAmount: number | null;
}

export interface Notification {
  // The stable dedupe/dismiss key (see the module header for the formats).
  key: string;
  kind: NotificationKind;
  // Amber for anomalies, info (sky) for new-bill items — drives the dot/styling.
  tone: NotificationTone;
  // The human-readable line. Anomalies reuse the flag's server-built message;
  // new-bill items are phrased here ("New bill: $X (Mon)").
  message: string;
  // A sortable integer, newest-first. For anomalies it's the flagged period's ym
  // (YYYYMM); for the bill it's the statement's YYYYMMDD. They're not the same
  // scale, but the bill is always rendered first below regardless (see sort).
  sortAt: number;
  // Source data for the click-to-open detail view (notification-details feature).
  // Exactly one is set per item, matching `kind`: the full AnomalyFlag for an
  // anomaly (so describeAnomaly can build the breakdown) and the latest-bill summary
  // for a new-bill item (the bell joins it to the bills table for period + PDF).
  flag?: AnomalyFlag;
  bill?: NotificationBill;
}

// Short month label (e.g. "Jun") from a YYYY-MM-DD statement date, without
// dragging in the locale-aware dateLabel (which would format the full date). Used
// only for the new-bill message's parenthetical.
function monthShort(statementDate: string): string {
  const m = Number(statementDate.slice(5, 7));
  const NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return m >= 1 && m <= 12 ? NAMES[m - 1] : '';
}

// Whole-dollar amount for the new-bill message (compact in the dropdown). Pure;
// mirrors format.ts' usd shape but stays dependency-free for the test.
function dollars(n: number | null | undefined): string {
  return n == null ? '—' : `$${Math.round(n).toLocaleString('en-US')}`;
}

// Build the in-app notification list from the overview and the dismissed-key set.
// Combines the latest-bill alert (one item, info) with one warning item per
// anomaly flag, drops anything whose key is dismissed, and sorts newest-first with
// the new-bill item pinned to the top (it's the freshest, most actionable event).
// PURE — same inputs always yield the same list.
export function buildNotifications(
  overview: NotificationsOverview | null | undefined,
  dismissed: string[]
): Notification[] {
  if (!overview) return [];
  const dismissedSet = new Set(dismissed);
  const out: Notification[] = [];

  // New-bill item — the most recent statement only (no per-historical-bill spam).
  const bill = overview.latestBill;
  if (bill?.statementDate) {
    const key = `bill:${bill.statementDate}`;
    if (!dismissedSet.has(key)) {
      const mon = monthShort(bill.statementDate);
      out.push({
        key,
        kind: 'bill',
        tone: 'info',
        message: `New bill: ${dollars(bill.totalDueAmount)}${mon ? ` (${mon})` : ''}`,
        sortAt: Number(bill.statementDate.replace(/-/g, '')) || 0,
        bill: { statementDate: bill.statementDate, totalDueAmount: bill.totalDueAmount },
      });
    }
  }

  // One anomaly item per flag, using the server-built message verbatim.
  for (const f of overview.anomalies?.flags ?? []) {
    const key = `anomaly:${f.ym}:${f.fuel}:${f.metric}`;
    if (dismissedSet.has(key)) continue;
    out.push({
      key,
      kind: 'anomaly',
      tone: 'warning',
      message: f.message,
      sortAt: f.ym,
      flag: f,
    });
  }

  // Newest first, but always pin the new-bill item above anomalies (the bill's
  // YYYYMMDD and an anomaly's YYYYMM aren't on the same scale, and the new bill is
  // the headline event). Within a kind, higher sortAt first.
  return out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'bill' ? -1 : 1;
    return b.sortAt - a.sortAt;
  });
}

// ---------------------------------------------------------------------------
// Server-side notification log (notification-log feature). The PURE derivation of
// the rows to UPSERT into the Notification table: one per bill (the full history,
// not just the latest) and one per current anomaly flag. The impure store
// (notificationStore.ts) computes these from the account's bills + detectAnomalies
// and idempotently upserts them by (accountId, key) — INSERT only, never touching
// readAt/createdAt — so this stays a no-DB, hand-testable transform.
//
// Keys are the SAME stable formats the in-app bell already used (see the header):
//   bill:{statementDate}                  (one per stored bill)
//   anomaly:{ym}:{fuel}:{metric}          (one per flag)
// so a row is created once and read/unread is tracked against it forever.
// ---------------------------------------------------------------------------

// One bill the log derives from — the shaped, client-safe summary (no secret /
// account number). Structurally a subset of queries.ts' shapeBill output.
export interface NotificationBillInput {
  statementDate: string;
  totalDueAmount: number | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  hasPdf?: boolean;
}

// A row to upsert into the Notification table. `payload` is the JSON the detail
// modal renders later (the AnomalyFlag for an anomaly, the bill summary for a
// bill); it must never carry a secret. accountId is nullable to match the model
// (env-bootstrapped data could have no account row, though in practice it's set).
export interface NotificationRow {
  accountId: number | null;
  kind: NotificationKind;
  key: string;
  title: string;
  message: string;
  payload: NotificationBillInput | AnomalyFlag;
}

// Build the notification ROWS for an account from its full bill history and its
// current anomaly flags: one 'bill' row per bill and one 'anomaly' row per flag,
// each with its stable key, a human title/message, and the payload the detail view
// needs. PURE — same inputs always yield the same rows (no DB, no ordering
// promise; the store/list layer orders by createdAt). Bills first, then anomalies.
export function deriveNotifications(
  bills: NotificationBillInput[],
  anomalies: AnomalyFlag[],
  accountId: number | null
): NotificationRow[] {
  const out: NotificationRow[] = [];

  for (const b of bills) {
    if (!b.statementDate) continue;
    const mon = monthShort(b.statementDate);
    out.push({
      accountId,
      kind: 'bill',
      key: `bill:${b.statementDate}`,
      title: 'New bill',
      message: `New bill: ${dollars(b.totalDueAmount)}${mon ? ` (${mon})` : ''}`,
      payload: {
        statementDate: b.statementDate,
        totalDueAmount: b.totalDueAmount,
        periodFrom: b.periodFrom ?? null,
        periodTo: b.periodTo ?? null,
        hasPdf: b.hasPdf ?? false,
      },
    });
  }

  for (const f of anomalies) {
    out.push({
      accountId,
      kind: 'anomaly',
      key: `anomaly:${f.ym}:${f.fuel}:${f.metric}`,
      title: describeAnomaly(f).title,
      message: f.message,
      payload: f,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Anomaly retraction helper (issue #112). Pure: no DB/React. Identifies stored
// anomaly keys that should be deleted because the underlying data for the LATEST
// evaluated month has corrected (the flag cleared) — i.e. transient false
// positives from a bad scrape value that was later corrected.
//
// ONLY retracts anomalies whose ym === latestYm and whose key is no longer in the
// current expected set. Anomalies for older months (genuine historical records)
// are NEVER touched. Bills are NEVER touched. Nothing is deleted when latestYm is
// null (detection couldn't run).
//
// The key format is `anomaly:{ym}:{fuel}:{metric}` — parse `ym` from segment [1].
// ---------------------------------------------------------------------------

// Parse the ym from an anomaly key (`anomaly:{ym}:{fuel}:{metric}`).
// Returns NaN when the key doesn't match the expected shape.
function parseAnomalyYm(key: string): number {
  if (!key.startsWith('anomaly:')) return NaN;
  return Number(key.split(':')[1]);
}

// Returns the subset of storedAnomalyKeys that should be deleted: those whose
// parsed ym equals latestYm AND whose key is not in currentAnomalyKeys.
// Keys that don't parse cleanly (NaN ym) are left alone.
export function anomalyKeysToRetract(
  storedAnomalyKeys: string[],
  currentAnomalyKeys: string[],
  latestYm: number
): string[] {
  const currentSet = new Set(currentAnomalyKeys);
  return storedAnomalyKeys.filter((key) => {
    const ym = parseAnomalyYm(key);
    return Number.isFinite(ym) && ym === latestYm && !currentSet.has(key);
  });
}

// ---------------------------------------------------------------------------
// Anomaly detail (notification-details feature). Clicking an anomaly notification
// opens a breakdown; this pure helper turns the raw AnomalyFlag into the structured
// fields that view renders, so NO formatting/arithmetic lives in the component. It
// re-states the flag's numbers in their right units and adds a plain-language,
// non-alarmist "what this can mean" line tailored to the (metric, direction). PURE
// — hand-tested in notifications.test.ts.
// ---------------------------------------------------------------------------

export interface AnomalyDetail {
  // "Electric rate anomaly — May 2026" (fuel + metric + the flagged period).
  title: string;
  // The flag's server-built headline (shared wording with the email channel).
  headline: string;
  // What `latest`/`median` mean in words, e.g. "weather-normalized usage intensity"
  // or "all-in rate" — labels the stats list so the units read correctly.
  metricLabel: string;
  // This period's value and the recent typical, already unit-formatted ($/kWh,
  // $/therm for rate; a plain intensity number for usage).
  latest: string;
  median: string;
  // Signed % difference from the recent typical ("+28%", "−12%").
  pct: string;
  // How far outside normal, e.g. "5.2× the normal month-to-month variation", or a
  // flat-history phrasing when the flag's deviations is non-finite.
  deviations: string;
  // Factual, tailored sentence about a plausible cause/meaning.
  meaning: string;
}

const DETAIL_FUEL_LABEL: Record<AnomalyFlag['fuel'], string> = { elec: 'Electric', gas: 'Gas' };

// Long month name from a YYYYMM integer (e.g. 202605 -> "May 2026"). Local to this
// module (the dropdown's monthShort is YYYY-MM-DD shaped and abbreviated).
function ymTitle(ym: number): string {
  const NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const y = Math.floor(ym / 100);
  const m = ym % 100;
  return m >= 1 && m <= 12 ? `${NAMES[m - 1]} ${y}` : String(ym);
}

// Signed whole-percent from a fraction, true-minus to match format.ts' signedPct
// (kept inline so notifications stays a single import of value formatters).
function signedPct(frac: number): string {
  const p = Math.round(frac * 100);
  return p > 0 ? `+${p}%` : p < 0 ? `−${Math.abs(p)}%` : '0%';
}

// Plain-language, factual cause line per (metric, direction). Usage is the
// weather-normalized intensity (so an "above" can't be blamed on weather); rate is
// the all-in $/unit (so an "above" points at supply/ESCO pricing).
function meaningLine(flag: AnomalyFlag): string {
  const fuel = flag.fuel === 'elec' ? 'electricity' : 'gas';
  if (flag.metric === 'usage') {
    return flag.direction === 'above'
      ? `Usage is high even after accounting for the weather, so it isn't just a hot or cold month — something new running all the time, or equipment starting to fail, could explain it.`
      : `Usage is low even after accounting for the weather — often something you turned off or replaced, or a shorter or estimated meter read.`;
  }
  return flag.direction === 'above'
    ? `The ${fuel} price you paid rose more than usual — commonly a supply rate or fixed-charge increase from your provider.`
    : `The ${fuel} price you paid dropped below its usual range — commonly a supply rate decrease.`;
}

// Build the structured detail for an anomaly flag (see AnomalyDetail). Formats
// rate values as $/kWh or $/therm and usage intensities as a 3-dp number labelled
// "weather-normalized usage intensity"; reports `deviations` as a "× the normal
// month-to-month variation" multiple (with a flat-history fallback when the flag's
// MAD was zero and deviations is Infinity). PURE.
export function describeAnomaly(flag: AnomalyFlag): AnomalyDetail {
  const isRate = flag.metric === 'rate';
  const fuelLabel = DETAIL_FUEL_LABEL[flag.fuel];
  const metricWord = isRate ? 'rate' : 'usage';

  // Units: rate is $/kWh (elec) or $/therm (gas); usage is the weather-normalized
  // intensity (kWh/degree-day, therms/HDD) — a small unitless-ish number, shown to
  // 3 dp and labelled rather than carrying a noisy compound unit in the value.
  const fmtVal = (v: number) => (isRate ? rate(v) : num(v, 3));
  const rateUnit = flag.fuel === 'elec' ? '$/kWh' : '$/therm';
  const metricLabel = isRate ? `all-in price (${rateUnit})` : 'weather-adjusted usage';

  const deviations = Number.isFinite(flag.deviations)
    ? `${num(flag.deviations, 1)}× the normal month-to-month variation`
    : 'a jump from a previously flat history';

  return {
    title: `${fuelLabel} ${metricWord} anomaly — ${ymTitle(flag.ym)}`,
    headline: flag.message,
    metricLabel,
    latest: fmtVal(flag.latest),
    median: fmtVal(flag.median),
    pct: signedPct(flag.pct),
    deviations,
    meaning: meaningLine(flag),
  };
}
