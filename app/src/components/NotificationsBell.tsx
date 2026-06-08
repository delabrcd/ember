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
import { describeAnomaly, type AnomalyDetail } from '@/lib/notifications';
import type { AnomalyFlag } from '@/lib/anomaly';
import type { Bill } from './useDashboardData';
import { usePrefs } from '@/lib/prefs';
import { DetailModal } from './DetailModal';
import { usd, dateLabel } from '@/lib/format';

// One stored log row, as the API returns it. `payload` is the AnomalyFlag (anomaly)
// or the bill summary (bill) that the detail modal renders.
interface LogItem {
  id: number;
  kind: string; // 'bill' | 'anomaly'
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

export function NotificationsBell({
  accountId = null,
  bills = [],
  onOpenCompare,
}: {
  // The account the dashboard is scoped to (null = default). Scopes the log fetch.
  accountId?: number | null;
  // The loaded bills (for the new-bill detail PDF link, joined by statementDate).
  // The payload also carries hasPdf, but we prefer the live bills list when present.
  bills?: Bill[];
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

  // Close on Esc and on a click/tap outside the wrapper, but only while open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

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
          className="absolute right-0 z-40 mt-2 w-80 max-w-[90vw] overflow-hidden rounded-xl border border-slate-800 bg-slate-900 shadow-2xl"
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

          <ul className="max-h-80 overflow-y-auto">
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
                      {/* Tone dot: amber for anomalies (warning), sky for new-bill
                          (info); a hollow ring once read. */}
                      <span
                        aria-hidden
                        className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                          isRead
                            ? 'border border-slate-600 bg-transparent'
                            : n.kind === 'anomaly'
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
          <BillDetailBody payload={detail.payload as BillPayload} bills={bills} />
        ) : null}
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
        <dt className="text-slate-500">Recent typical (median)</dt>
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

// New-bill summary body — amount, statement date, service period, and a View PDF
// link when one exists. The stored payload carries the statement + amount + period
// + hasPdf; we prefer the live bills list (by statementDate) for hasPdf when it's
// loaded, falling back to the payload otherwise.
function BillDetailBody({ payload, bills }: { payload: BillPayload; bills: Bill[] }) {
  const full = bills.find((x) => x.statementDate === payload.statementDate);
  const periodFrom = full?.periodFrom ?? payload.periodFrom ?? null;
  const periodTo = full?.periodTo ?? payload.periodTo ?? null;
  const hasPdf = full?.hasPdf ?? payload.hasPdf ?? false;
  const period = periodFrom ? `${dateLabel(periodFrom)} – ${dateLabel(periodTo)}` : '—';
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
