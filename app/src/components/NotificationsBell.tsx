'use client';

// Header notifications bell + dropdown (notification-log feature). The in-app view
// of the persistent server-side notification log: it FETCHES the stored log
// (GET /api/notifications) — every new-bill (#7) and anomaly (#45) event, with
// read/unread — instead of deriving items from current overview state. So there's
// a clickable history that survives reloads, and read state is server-side.
//
// Read/unread (no more permanent dismiss): clicking an item opens its detail modal
// AND marks it read (POST { key }); a "Mark all read" header action clears the
// badge (POST { all: true }). A "Show read" toggle (OFF by default, persisted in
// prefs) reveals already-read items, rendered muted; by default only unread show.
// The badge counts unread (from the server's unreadCount).
//
// It's a plain anchored popover (no portal): a relatively-positioned wrapper with
// an absolutely-positioned panel below the button. Closes on Esc and on an
// outside click/tap; the bell is a real <button> with an aria-label that includes
// the unread count, and the count badge hides at 0.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useDismissable } from '@/lib/hooks/useDismissable';
import { describeAnomaly, type AnomalyDetail } from '@/lib/notifications';
import type { AnomalyFlag } from '@/lib/anomaly';
import type { Bill } from './useDashboardData';
import type { MonthRow } from '@/lib/chartSpec';
import { usePrefs } from '@/lib/prefs';
import { DetailModal } from './DetailModal';
import { usd, dateLabel, num, rate, signedPct } from '@/lib/format';
import { buildBillRecap, type RecapComparison, type FuelDelta, type AllInDelta } from '@/lib/billRecap';
import { ymdToYm } from '@/lib/range';

// One stored log row, as the API returns it. `payload` is the AnomalyFlag (anomaly)
// or the bill summary (bill) that the detail modal renders.
interface LogItem {
  id: number;
  kind: string; // 'bill' | 'anomaly' | 'scrape'
  key: string;
  title: string;
  message: string;
  payload: unknown;
  createdAt: string;
  readAt: string | null;
}

// The bill summary shape stored in a 'bill' row's payload (see deriveNotifications).
interface BillPayload {
  statementDate: string;
  totalDueAmount: number | null;
  periodFrom?: string | null;
  periodTo?: string | null;
  hasPdf?: boolean;
}

// The scrape-sanity-floor shape stored in a 'scrape' row's payload (#135). Loosely
// typed — every field is optional so a missing/old payload renders without crashing.
interface ScrapePayload {
  stream?: string;
  prior?: number;
  reason?: string;
  ymd?: string;
}

export function NotificationsBell({
  accountId = null,
  bills = [],
  rows = [],
  onOpenCompare,
}: {
  // The account the dashboard is scoped to (null = default). Scopes the log fetch.
  accountId?: number | null;
  // The loaded bills (for the new-bill detail PDF link, joined by statementDate).
  // The payload also carries hasPdf, but we prefer the live bills list when present.
  bills?: Bill[];
  // The full monthly series — passed down to BillDetailBody for the bill recap (#111).
  rows?: MonthRow[];
  // Optional cross-link from the anomaly detail to the Tools → Compare tab.
  onOpenCompare?: () => void;
}) {
  const { prefs, patch } = usePrefs();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<LogItem[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  // The log row whose detail modal is open (null = none).
  const [detail, setDetail] = useState<LogItem | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const scope = accountId != null ? `?accountId=${accountId}` : '';

  // Fetch the log (also backfills history server-side). Called on mount, when the
  // account changes, and after any mark-read so the badge + list stay in sync.
  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/notifications${scope}`, { cache: 'no-store' });
      const data = await res.json();
      setItems(Array.isArray(data.notifications) ? data.notifications : []);
      setUnreadCount(typeof data.unreadCount === 'number' ? data.unreadCount : 0);
    } catch {
      /* keep whatever we had */
    }
  }, [scope]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Mark one read by key (optimistic, then re-sync). Idempotent server-side.
  const markRead = useCallback(
    async (key: string) => {
      setItems((prev) => prev.map((n) => (n.key === key && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)));
      setUnreadCount((c) => Math.max(0, c - 1));
      try {
        await fetch(`/api/notifications${scope}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key }),
        });
      } catch {
        /* ignore */
      }
      void refresh();
    },
    [scope, refresh]
  );

  const markAllRead = useCallback(async () => {
    const now = new Date().toISOString();
    setItems((prev) => prev.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    setUnreadCount(0);
    try {
      await fetch(`/api/notifications${scope}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
    } catch {
      /* ignore */
    }
    void refresh();
  }, [scope, refresh]);

  // Clicking an item: open its detail AND mark it read.
  const openDetail = (n: LogItem) => {
    setDetail(n);
    if (!n.readAt) void markRead(n.key);
  };

  // Close on Esc and on a click/tap outside the wrapper, but only while open (#150:
  // the shared useDismissable hook — default mousedown listener).
  useDismissable(wrapRef, open, () => setOpen(false));

  const showRead = prefs.showReadNotifications;
  // Default view hides read; with the toggle on we show everything (read muted).
  const visible = showRead ? items : items.filter((n) => !n.readAt);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unreadCount ? ` (${unreadCount} unread)` : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        className="btn relative border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 0 1-3.46 0" />
        </svg>
        {/* Unread-count badge — hidden at 0. */}
        {unreadCount > 0 ? (
          <span className="absolute -right-1.5 -top-1.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold leading-4 text-slate-950">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Notifications"
          // Mobile (< sm): a viewport-pinned panel — fixed, near-full-width with small
          // side margins (inset-x-2) just under the header, clamped to the viewport
          // width and a max-height with internal scroll, so it can't overflow off the
          // left/right of a narrow phone screen. Desktop (sm+): the original anchored
          // popover (absolute, right-aligned under the bell, fixed width).
          className="fixed inset-x-2 top-16 z-40 flex max-h-[70vh] max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-2xl sm:absolute sm:inset-x-auto sm:right-0 sm:top-auto sm:mt-2 sm:max-h-none sm:w-80 sm:max-w-[90vw]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-slate-800/70 px-3 py-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Notifications</span>
            <div className="flex items-center gap-2">
              {unreadCount > 0 ? (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="text-[11px] text-amber-400 hover:underline"
                >
                  Mark all read
                </button>
              ) : null}
            </div>
          </div>

          {/* Filter row: "Show read" toggle (OFF by default), persisted in prefs. */}
          <div className="flex items-center justify-between border-b border-slate-800/50 px-3 py-1.5">
            <span className="text-[11px] text-slate-500">
              {unreadCount > 0 ? `${unreadCount} unread` : 'All caught up'}
            </span>
            <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400">
              <input
                type="checkbox"
                checked={showRead}
                onChange={(e) => patch({ showReadNotifications: e.target.checked })}
                className="h-3 w-3 accent-amber-500"
              />
              Show read
            </label>
          </div>

          <ul className="min-h-0 flex-1 overflow-y-auto sm:max-h-80 sm:flex-none">
            {visible.length === 0 ? (
              <li className="px-3 py-6 text-center text-xs text-slate-500">
                {showRead ? 'No notifications' : 'No unread notifications'}
              </li>
            ) : (
              visible.map((n) => {
                const isRead = !!n.readAt;
                return (
                  <li key={n.id} className="border-b border-slate-800/50 last:border-b-0">
                    {/* The whole item is a button: click / Enter / Space opens the
                        detail modal and marks it read. Read items render muted. */}
                    <button
                      type="button"
                      onClick={() => openDetail(n)}
                      className={`flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-slate-800/50 focus:outline-none focus-visible:bg-slate-800/60 ${
                        isRead ? 'opacity-60' : ''
                      }`}
                    >
                      {/* Tone dot: amber for warnings (anomaly + scrape-gap), sky for
                          new-bill (info); a hollow ring once read. */}
                      <span
                        aria-hidden
                        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                          isRead
                            ? 'border border-slate-600 bg-transparent'
                            : n.kind === 'anomaly' || n.kind === 'scrape'
                              ? 'bg-amber-400'
                              : 'bg-sky-400'
                        }`}
                      />
                      <span className={`min-w-0 flex-1 text-xs leading-snug ${isRead ? 'text-slate-400' : 'text-slate-200'}`}>
                        {n.message}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          {/* Footer: a quiet pointer to where the email/webhook/ntfy channel toggles
              live — this dropdown is just the in-app view of those same alerts. */}
          <div className="border-t border-slate-800/70 px-3 py-2 text-[11px] text-slate-500">
            Also sent via email/webhook ·{' '}
            <Link href="/settings" className="text-amber-400 hover:underline" onClick={() => setOpen(false)}>
              Notification settings
            </Link>
          </div>
        </div>
      ) : null}

      {/* Click-to-open detail (notification-details feature). One DetailModal,
          rendered for whichever log row is selected; closes back to the open
          dropdown. The bill detail joins the loaded bills by statementDate for the
          PDF link (falling back to the row's stored payload). */}
      <DetailModal
        open={detail != null}
        onClose={() => setDetail(null)}
        title={detail?.title || 'Notification'}
      >
        {detail?.kind === 'anomaly' ? (
          <AnomalyDetailBody flag={detail.payload as AnomalyFlag} onOpenCompare={onOpenCompare} onClose={() => setDetail(null)} />
        ) : detail?.kind === 'bill' ? (
          <BillDetailBody payload={detail.payload as BillPayload} bills={bills} rows={rows} />
        ) : detail?.kind === 'scrape' ? (
          <ScrapeDetailBody message={detail.message} payload={detail.payload as ScrapePayload} />
        ) : (
          // Generic fallback — never render a blank body for an unknown future kind.
          <DefaultDetailBody message={detail?.message} />
        )}
      </DetailModal>
    </div>
  );
}

// Anomaly breakdown body — pure presentation of describeAnomaly(flag). A headline,
// a stats list (this period vs the recent typical, the % difference, how far
// outside normal), and a factual "what this can mean" line; optionally a button to
// the Tools → Compare tab.
function AnomalyDetailBody({
  flag,
  onOpenCompare,
  onClose,
}: {
  flag: AnomalyFlag;
  onOpenCompare?: () => void;
  onClose: () => void;
}) {
  const d: AnomalyDetail = describeAnomaly(flag);
  return (
    <div className="space-y-3">
      <p className="text-sm leading-snug text-slate-200">{d.headline}</p>
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-slate-500">This period</dt>
        <dd className="text-right font-medium text-slate-100">{d.latest}</dd>
        <dt className="text-slate-500">Recent typical</dt>
        <dd className="text-right text-slate-300">{d.median}</dd>
        <dt className="text-slate-500">Difference</dt>
        <dd className="text-right text-slate-300">{d.pct}</dd>
        <dt className="text-slate-500">Outside normal</dt>
        <dd className="text-right text-slate-300">{d.deviations}</dd>
      </dl>
      <p className="text-[11px] text-slate-500">Compared as {d.metricLabel}.</p>
      <p className="rounded-lg border border-slate-800 bg-slate-800/40 p-2.5 text-xs leading-snug text-slate-300">
        {d.meaning}
      </p>
      {onOpenCompare ? (
        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenCompare();
          }}
          className="btn w-full border border-slate-700/70 bg-slate-800/40 text-xs text-slate-200 hover:bg-slate-700"
        >
          Open Compare periods
        </button>
      ) : null}
    </div>
  );
}

// Scrape-sanity-floor body (#135) — pure presentation of a 'scrape' notification.
// The human message, a compact factual breakdown from the payload (affected stream
// + prior row count), and a "what this can mean" line steering the operator to
// verify the account against the National Grid portal. Defensive: every payload
// field is optional, so a missing field just renders an em dash.
function ScrapeDetailBody({ message, payload }: { message: string; payload: ScrapePayload }) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-snug text-slate-200">{message}</p>
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-slate-500">Affected stream</dt>
        <dd className="text-right font-medium text-slate-100">{payload.stream ?? '—'}</dd>
        <dt className="text-slate-500">Rows before this scrape</dt>
        <dd className="text-right text-slate-300">{payload.prior != null ? num(payload.prior) : '—'}</dd>
        <dt className="text-slate-500">Returned this scrape</dt>
        <dd className="text-right text-slate-300">0</dd>
        {payload.ymd ? (
          <>
            <dt className="text-slate-500">First flagged</dt>
            <dd className="text-right text-slate-300">{payload.ymd}</dd>
          </>
        ) : null}
      </dl>
      <p className="rounded-lg border border-slate-800 bg-slate-800/40 p-2.5 text-xs leading-snug text-slate-300">
        An established stream suddenly returned no rows. Existing data was preserved (nothing was
        overwritten). This can mean National Grid renamed an upstream field — verify the account
        against the National Grid portal and check for a scraper update.
      </p>
    </div>
  );
}

// Generic fallback body — a minimal, never-blank detail for any kind without a
// dedicated body (incl. future kinds). Shows just the stored message.
function DefaultDetailBody({ message }: { message?: string }) {
  return <p className="text-sm leading-snug text-slate-200">{message || 'No additional detail.'}</p>;
}

// ── Bill Recap helpers ────────────────────────────────────────────────────────

// Direction/color convention: a LOWER bill is good (green); higher is amber/red.
// Matches the existing anomaly coloring (amber for elevated, green for improved).
function costColor(delta: number | null | undefined): string {
  if (delta == null) return 'text-slate-300';
  if (delta < 0) return 'text-emerald-400'; // cheaper — good
  if (delta > 0) return 'text-amber-400'; // more expensive — warn
  return 'text-slate-300';
}

// Signed dollar delta with true-minus sign.
function signedUsd(delta: number | null | undefined, dp = 0): string {
  if (delta == null) return '—';
  const abs = usd(Math.abs(delta), dp);
  if (delta < 0) return `−${abs}`;
  if (delta > 0) return `+${abs}`;
  return abs;
}

// One fuel row in the recap table: label | cost Δ | Δ% | usage Δ | rate Δ
function FuelRecapRow({
  label,
  accent,
  unit,
  fuel,
}: {
  label: string;
  accent: string;
  unit: string;
  fuel: FuelDelta | null;
}) {
  if (!fuel) {
    return (
      <>
        <dt className={`font-medium ${accent}`}>{label}</dt>
        <dd className="text-right text-slate-500">—</dd>
        <dd className="text-right text-slate-500">—</dd>
        <dd className="text-right text-slate-500">—</dd>
        <dd className="text-right text-slate-500">—</dd>
      </>
    );
  }
  return (
    <>
      <dt className={`font-medium ${accent}`}>{label}</dt>
      <dd className={`text-right ${costColor(fuel.costDelta)}`}>{signedUsd(fuel.costDelta)}</dd>
      <dd className={`text-right ${costColor(fuel.costDelta)}`}>{signedPct(fuel.costPct)}</dd>
      <dd className="text-right text-slate-300">
        {fuel.usageDelta != null
          ? `${fuel.usageDelta >= 0 ? '+' : ''}${num(Math.round(fuel.usageDelta))} ${unit}`
          : '—'}
      </dd>
      <dd className="text-right text-slate-400">
        {fuel.rateDelta != null ? `${fuel.rateDelta >= 0 ? '+' : ''}${rate(fuel.rateDelta, 3)}/u` : '—'}
      </dd>
    </>
  );
}

// All-in row: label | cost Δ | Δ% | per-day note | —
function AllInRecapRow({ allIn }: { allIn: AllInDelta | null }) {
  if (!allIn) {
    return (
      <>
        <dt className="font-medium text-slate-300">Total</dt>
        <dd className="text-right text-slate-500">—</dd>
        <dd className="text-right text-slate-500">—</dd>
        <dd className="col-span-2 text-right text-slate-500">—</dd>
      </>
    );
  }
  return (
    <>
      <dt className="font-medium text-slate-300">Total</dt>
      <dd className={`text-right font-semibold ${costColor(allIn.costDelta)}`}>{signedUsd(allIn.costDelta)}</dd>
      <dd className={`text-right ${costColor(allIn.costDelta)}`}>{signedPct(allIn.costPct)}</dd>
      <dd className="col-span-2 text-right text-slate-400 text-[10px]">
        {allIn.costPerDayDelta != null
          ? `${allIn.costPerDayDelta >= 0 ? '+' : ''}${usd(allIn.costPerDayDelta, 2)}/day`
          : null}
      </dd>
    </>
  );
}

// Color for weather-normalized usage: less usage = good (green), more = amber.
// Inverse of costColor because lower usage is the "good" direction.
function usageNormColor(pct: number | null | undefined): string {
  if (pct == null) return 'text-slate-400';
  if (pct < 0) return 'text-emerald-400'; // used less per degree-day — good
  if (pct > 0) return 'text-amber-400'; // used more per degree-day — warn
  return 'text-slate-400';
}

// One comparison column (vs last bill or vs year-ago bill).
function RecapColumn({
  comparison,
  heading,
}: {
  comparison: RecapComparison;
  heading: string;
}) {
  const { daysA, daysB } = comparison;
  const diffDays = daysA != null && daysB != null ? daysA - daysB : null;

  // Weather-adjusted usage fragments: one per fuel that has normalizedUsagePct.
  // "less usage = green" convention (same as usageNormColor).
  const wxFragments: { label: string; pct: number }[] = [];
  if (comparison.elec?.normalizedUsagePct != null)
    wxFragments.push({ label: 'Elec', pct: comparison.elec.normalizedUsagePct });
  if (comparison.gas?.normalizedUsagePct != null)
    wxFragments.push({ label: 'Gas', pct: comparison.gas.normalizedUsagePct });

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-800/30 p-2.5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{heading}</span>
        <span className="text-[10px] text-slate-500">{comparison.baselineLabel}</span>
      </div>
      {/* Period-length note when the cycle lengths differ noticeably (>1 day).
          Direction-aware: this bill's cycle may be longer OR shorter than the
          baseline, so a raw Δ$ can mislead — point at the per-day figure. */}
      {diffDays != null && Math.abs(diffDays) > 1 ? (
        <p className="mb-2 text-[10px] text-slate-500">
          {Math.abs(diffDays)}-day {diffDays > 0 ? 'longer' : 'shorter'} cycle than baseline
          {' '}—{' '}
          {comparison.allIn?.costPerDayDelta != null ? 'see per-day below' : 'compare per-day rate'}
        </p>
      ) : null}
      {/* 5-column grid: label | Δ$ | Δ% | usage Δ | rate Δ */}
      <dl className="grid grid-cols-[auto,auto,auto,auto,auto] items-baseline gap-x-2 gap-y-1 text-xs">
        {/* Column headings */}
        <dt className="text-[10px] text-slate-600" />
        <dd className="text-right text-[10px] text-slate-600">Δ$</dd>
        <dd className="text-right text-[10px] text-slate-600">Δ%</dd>
        <dd className="text-right text-[10px] text-slate-600">usage</dd>
        <dd className="text-right text-[10px] text-slate-600">rate</dd>

        <FuelRecapRow label="Elec" accent="text-amber-400" unit="kWh" fuel={comparison.elec} />
        <FuelRecapRow label="Gas" accent="text-sky-400" unit="th" fuel={comparison.gas} />
        <AllInRecapRow allIn={comparison.allIn} />
      </dl>
      {/* Weather-adjusted usage line — shown only when at least one fuel has degree-day data.
          Strips the weather effect from the raw usage change so you can see if activity
          (not just temperature) drove the difference. Raw usage is still visible above. */}
      {wxFragments.length > 0 ? (
        <p className="mt-1.5 text-[10px] text-slate-500" title="Usage change after removing the weather effect (degree-day normalized). Raw usage Δ shown above.">
          <span className="text-slate-600">Wx-adj usage — </span>
          {wxFragments.map((f, i) => (
            <span key={f.label}>
              {i > 0 ? <span className="text-slate-700"> · </span> : null}
              <span className="text-slate-500">{f.label} </span>
              <span className={usageNormColor(f.pct)}>{signedPct(f.pct)}</span>
            </span>
          ))}
        </p>
      ) : null}
    </div>
  );
}

// New-bill summary body — amount, statement date, service period, PDF link, and
// (when the monthly series is available) a Bill Recap comparing this bill to the
// prior statement and to the same month last year (#111).
function BillDetailBody({ payload, bills, rows }: { payload: BillPayload; bills: Bill[]; rows: MonthRow[] }) {
  const full = bills.find((x) => x.statementDate === payload.statementDate);
  const periodFrom = full?.periodFrom ?? payload.periodFrom ?? null;
  const periodTo = full?.periodTo ?? payload.periodTo ?? null;
  const hasPdf = full?.hasPdf ?? payload.hasPdf ?? false;
  const period = periodFrom ? `${dateLabel(periodFrom)} – ${dateLabel(periodTo)}` : '—';

  // Build the recap only when we have a series and can derive a ym from the
  // statement date. This derives from already-stored rows — never persists.
  const statementYm = ymdToYm(payload.statementDate);
  const recap = statementYm != null && rows.length > 0
    ? buildBillRecap(rows, statementYm)
    : null;

  const hasAnyComparison = recap && (recap.vsLast != null || recap.vsYearAgo != null);

  return (
    <div className="space-y-3">
      <div>
        <div className="text-2xl font-semibold text-slate-100">{usd(payload.totalDueAmount)}</div>
        <div className="text-[11px] text-slate-500">Amount due</div>
      </div>
      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1.5 text-xs">
        <dt className="text-slate-500">Statement date</dt>
        <dd className="text-right text-slate-200">{dateLabel(payload.statementDate)}</dd>
        <dt className="text-slate-500">Service period</dt>
        <dd className="text-right text-slate-200">{period}</dd>
      </dl>

      {/* Bill Recap (#111): per-fuel + all-in deltas vs prior bill and same month last year. */}
      {hasAnyComparison ? (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Bill recap</p>
          <p className="text-[10px] text-slate-500">Period energy cost — not amount due</p>
          <div className="flex flex-col gap-2">
            {recap.vsLast ? (
              <div className="min-w-0">
                <RecapColumn comparison={recap.vsLast} heading="vs last bill" />
              </div>
            ) : null}
            {recap.vsYearAgo ? (
              <div className="min-w-0">
                <RecapColumn comparison={recap.vsYearAgo} heading="vs year ago" />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {hasPdf ? (
        <a
          href={`/api/bills/${payload.statementDate}/pdf`}
          target="_blank"
          rel="noreferrer"
          className="btn block w-full border border-slate-700/70 bg-slate-800/40 text-center text-xs text-amber-400 hover:bg-slate-700 hover:text-amber-300"
        >
          View PDF
        </a>
      ) : (
        <p className="text-[11px] text-slate-500">No PDF available for this statement.</p>
      )}
    </div>
  );
}
