'use client';

import { useCallback, useEffect, useState } from 'react';
import type { MonthRow } from '@/lib/chartSpec';
import { resolveSelectedAccountId, type AccountSummary } from '@/lib/accountSwitcher';
import { usePrefs } from '@/lib/prefs';
import { useScrapeProgress } from './ScrapeProgress';
import type { RunStatus, ProgressRun } from '@/lib/ngrid/progress';

export interface Overview {
  empty?: boolean;
  account?: { accountNumber: string; serviceAddress?: string | null; region?: string | null; companyCode?: string | null; fuelTypes?: string[] } | null;
  billCount?: number;
  lifetimeSpend?: number;
  nextBillEstimate?: { point: number; low: number; high: number; basis: string } | null;
  latestBill?: { statementDate: string; totalDueAmount: number | null } | null;
  firstStatement?: string | null;
  schedule?: { predictedNextBillDate: string | null; nextCheckAt: string | null; lastCheckedAt: string | null } | null;
  lastRun?: { id: number; status: RunStatus; trigger: string; startedAt: string; finishedAt: string | null; message: string | null } | null;
}

export interface Bill {
  statementDate: string;
  periodFrom: string | null;
  periodTo: string | null;
  totalDueAmount: number | null;
  hasPdf: boolean;
}

export interface DashboardData {
  // Fetched state the dashboard renders.
  ov: Overview | null;
  rows: MonthRow[];
  bills: Bill[];
  accounts: AccountSummary[];
  loading: boolean;
  reauthLogins: { id: number; label: string }[];
  needsSetup: boolean | null;
  hasLogin: boolean;
  // The selected account, validated against the live list (a stale persisted id
  // is ignored). null = the default account, which the routes already resolve.
  selectedAccountId: number | null;
  // Live scrape-progress (issue #40): the tracked run, derived `scraping` flag,
  // and the banner's action callbacks.
  progressRun: ProgressRun | null;
  scraping: boolean;
  trackRun: (runId: number) => void;
  dismissProgress: () => void;
  retryScrape: () => Promise<void>;
  // Action callbacks the component wires to buttons.
  load: () => Promise<void>;
  loadLogins: () => Promise<void>;
}

// Owns the dashboard's three independent fetch lifecycles plus the live
// scrape-progress polling, returning the state the component renders and the
// action callbacks it wires to buttons/banners. Extracted from Dashboard.tsx so
// the component is a thin orchestration shell — behavior is identical: same fetch
// URLs, dependency arrays, polling interval/cleanup, and state transitions.
export function useDashboardData(): DashboardData {
  const { prefs, loaded } = usePrefs();
  const [ov, setOv] = useState<Overview | null>(null);
  const [rows, setRows] = useState<MonthRow[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // Logins flagged needs_reauth: scraping for them is paused until the operator
  // re-authenticates (in Settings). Existing data keeps showing regardless.
  const [reauthLogins, setReauthLogins] = useState<{ id: number; label: string }[]>([]);
  // First-run setup: a brand-new install with no data and no credential to scrape
  // with. Shows the guided setup state instead of the empty dashboard. null until
  // /api/ng-logins answers, so we don't flash the wrong state on load.
  const [needsSetup, setNeedsSetup] = useState<boolean | null>(null);
  // Becomes true once a login has been added during setup, so we can prompt for
  // the initial scrape ("Check for new bills") right there.
  const [hasLogin, setHasLogin] = useState(false);

  // The selected account, validated against the live list (a stale persisted id
  // is ignored). null = the default account, which the routes already resolve.
  const selectedAccountId = resolveSelectedAccountId(accounts, prefs.selectedAccountId);
  // Scope every data fetch to the selection; no param = default-account behaviour.
  const scope = selectedAccountId != null ? `?accountId=${selectedAccountId}` : '';

  // The account list is independent of the selection, so fetch it once.
  useEffect(() => {
    fetch('/api/accounts', { cache: 'no-store' })
      .then((r) => r.json())
      .then((a) => setAccounts(a.accounts || []))
      .catch(() => setAccounts([]));
  }, []);

  // Pull the NG-login state: surfaces any login that needs re-authentication (so
  // the operator knows scraping is paused for it) AND the first-run `needsSetup`
  // flag. Re-fetched after a login is added during setup so the UI advances.
  const loadLogins = useCallback(async () => {
    try {
      const j: {
        needsSetup?: boolean;
        logins?: { id: number; label: string; status: string | null }[];
      } = await fetch('/api/ng-logins', { cache: 'no-store' }).then((r) => r.json());
      const logins = j.logins || [];
      setReauthLogins(
        logins.filter((l) => l.status === 'needs_reauth').map((l) => ({ id: l.id, label: l.label }))
      );
      setNeedsSetup(Boolean(j.needsSetup));
      setHasLogin(logins.length > 0);
    } catch {
      setReauthLogins([]);
      setNeedsSetup(false);
    }
  }, []);

  useEffect(() => {
    loadLogins();
  }, [loadLogins]);

  const load = useCallback(async () => {
    const [o, s, b] = await Promise.all([
      fetch(`/api/overview${scope}`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`/api/series${scope}`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`/api/bills${scope}`, { cache: 'no-store' }).then((r) => r.json()),
    ]);
    setOv(o);
    setRows(s.rows || []);
    setBills(b.bills || []);
    setLoading(false);
  }, [scope]);

  // Re-fetch on mount and whenever the selected account changes. Wait until prefs
  // have loaded so the first fetch already reflects a persisted selection rather
  // than firing for the default and then again for the restored account.
  useEffect(() => {
    if (loaded) load();
  }, [load, loaded]);

  // Live scrape-progress indicator (issue #40). Tracks the in-flight run — either
  // one the page loaded mid-scrape (overview's `lastRun`, RUNNING) or one the
  // Refresh button just started — and shows the animated banner below the header.
  // On SUCCESS we refresh dashboard data + login state so the new bills appear.
  const initialRun: ProgressRun | null = ov?.lastRun
    ? { id: ov.lastRun.id, status: ov.lastRun.status, message: ov.lastRun.message }
    : null;
  const {
    run: progressRun,
    track: trackRun,
    dismiss: dismissProgress,
  } = useScrapeProgress(initialRun, () => {
    load();
    loadLogins();
  });
  const scraping = progressRun?.status === 'RUNNING';

  // Retry from the error banner: kick a fresh scrape and adopt it. Mirrors the
  // Refresh button's POST so the banner can recover without a page reload.
  const retryScrape = useCallback(async () => {
    try {
      const res = await fetch('/api/refresh', { method: 'POST' });
      if (!res.ok) return;
      const { runId } = await res.json();
      if (runId) trackRun(runId);
    } catch {
      /* leave the error banner in place */
    }
  }, [trackRun]);

  return {
    ov,
    rows,
    bills,
    accounts,
    loading,
    reauthLogins,
    needsSetup,
    hasLogin,
    selectedAccountId,
    progressRun,
    scraping,
    trackRun,
    dismissProgress,
    retryScrape,
    load,
    loadLogins,
  };
}
