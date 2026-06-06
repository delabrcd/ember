'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { SPEC_BY_ID, type MonthRow } from '@/lib/chartSpec';
import { trailing12AllIn } from '@/lib/series';
import { clampPage, paginate, usePrefs } from '@/lib/prefs';
import {
  filterByYm,
  filterBillsByYm,
  resolveRange,
  ymOfDate,
  ymToYmd,
  ymToLastYmd,
} from '@/lib/range';
import {
  buildAccountGroups,
  hasMultipleAccounts,
  resolveSelectedAccountId,
  type AccountSummary,
} from '@/lib/accountSwitcher';
import { ConfigurableChart } from './ConfigurableChart';
import { AccountSwitcher } from './AccountSwitcher';
import { RefreshButton } from './RefreshButton';
import { RangeControl } from './RangeControl';
import { NgLoginsSection } from './NgLoginsSection';
import { dateLabel, estimateTooltip, num, rate, relativeFromNow, usd } from '@/lib/format';

// Up to four charts per page in the paginated "fit" cockpit (issue #38), laid out
// 2×2 so each chart is comfortably tall on a laptop.
const CHARTS_PER_PAGE = 4;

// True once the viewport is ≥1280px (Tailwind's `xl`). Drives the JS half of the
// "fit" pagination: below xl (and on the server / first paint) we render the
// classic scrolling stack, so there's no hydration flash and no pagination on
// mobile. Updates on resize via matchMedia.
function useIsXl(): boolean {
  const [isXl, setIsXl] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1280px)');
    const sync = () => setIsXl(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);
  return isXl;
}

interface Overview {
  empty?: boolean;
  account?: { accountNumber: string; serviceAddress?: string | null; region?: string | null; companyCode?: string | null; fuelTypes?: string[] } | null;
  billCount?: number;
  lifetimeSpend?: number;
  nextBillEstimate?: { point: number; low: number; high: number; basis: string } | null;
  latestBill?: { statementDate: string; totalDueAmount: number | null } | null;
  firstStatement?: string | null;
  schedule?: { predictedNextBillDate: string | null; nextCheckAt: string | null; lastCheckedAt: string | null } | null;
}
interface Bill {
  statementDate: string;
  periodFrom: string | null;
  periodTo: string | null;
  totalDueAmount: number | null;
  hasPdf: boolean;
}

export function Dashboard() {
  const { prefs, patch, setRange, loaded } = usePrefs();
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

  const groups = buildAccountGroups(accounts);
  const showSwitcher = hasMultipleAccounts(accounts);
  const empty = !ov || ov.empty || !ov.billCount;
  const lastRow = [...rows].reverse().find((r) => r.elecRateSupply != null || r.gasRateSupply != null);
  const elecAllIn = trailing12AllIn(rows, 'elec');
  const gasAllIn = trailing12AllIn(rows, 'gas');
  const dp = prefs.currencyDecimals;

  // The selected date range drives every chart, the bills list and the export
  // scoping (issue #24) from a single persisted pref. resolveRange is pure; we
  // anchor it to today and the data's natural span.
  const nowYm = ymOfDate(new Date());
  const allYms = rows.map((r) => r.ym);
  const resolved = resolveRange(prefs.range, allYms, nowYm);
  const ranged = filterByYm(rows, resolved);
  const rangedBills = filterBillsByYm(bills, resolved);

  // The export links scope to BOTH the account and the on-screen date range so a
  // download matches what's visible. CSV exports take ym integers (from/to);
  // the PDF bundle takes a full-month ISO date span (its existing contract).
  const acctQuery = selectedAccountId != null ? `&accountId=${selectedAccountId}` : '';
  const csvScope = `&from=${resolved.fromYm}&to=${resolved.toYm}${acctQuery}`;
  const pdfScope = `?from=${ymToYmd(resolved.fromYm)}&to=${ymToLastYmd(resolved.toYm)}${acctQuery}`;

  const visibleCharts = prefs.order.filter((id) => prefs.charts[id]?.visible && SPEC_BY_ID[id]);
  const fit = prefs.density === 'fit';

  // Chart pagination (issue #38): in "fit" density at ≥xl we page through the
  // visible charts (in the user's chosen order) up to four at a time in a 2×2 grid
  // that fills the chart region — so charts are tall enough on a laptop and the
  // page never scrolls. Mobile (<768), the 768–1280 band, and "comfortable"
  // density all keep the classic scrolling stack (paginate=false below).
  const isXl = useIsXl();
  const paginateCharts = fit && isXl;
  const [page, setPage] = useState(0);
  const chartPages = paginate(visibleCharts, CHARTS_PER_PAGE);
  const pageCount = chartPages.length;
  // Clamp at render so the active page is always valid even if the visible set
  // shrank since `page` was last set (e.g. the operator hid charts in Settings).
  const activePage = clampPage(page, pageCount);
  // Keep state in sync with the clamp so the dots/label reflect reality and a
  // stale index doesn't linger. Cheap; only fires when it actually differs.
  useEffect(() => {
    if (page !== activePage) setPage(activePage);
  }, [page, activePage]);
  const pagedCharts = paginateCharts ? (chartPages[activePage] ?? []) : visibleCharts;
  const showPager = paginateCharts && pageCount > 1;

  // First-run setup: a fresh install with no data and nothing to scrape with.
  // Show a guided welcome + the add-login flow front-and-center instead of the
  // empty dashboard. Existing installs never reach here (needsSetup is false).
  if (needsSetup) {
    return (
      <div className="mx-auto max-w-2xl space-y-6 px-4 py-8 sm:px-6">
        <header className="text-center">
          <div className="flex items-center justify-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-slate-50">Welcome to your National Grid Dashboard</h1>
            <span className="rounded-full border border-slate-700/70 bg-slate-800/50 px-2 py-0.5 font-mono text-xs text-slate-400">
              v{process.env.NEXT_PUBLIC_APP_VERSION || 'dev'}
            </span>
          </div>
          <p className="mx-auto mt-2 max-w-prose text-sm text-slate-400">
            Let&apos;s get set up. Add your National Grid login below — it&apos;s stored encrypted (AES-256-GCM) and used
            only to scrape your own account&apos;s bills and usage. Adding it runs a real login to verify it; if National
            Grid sends a one-time code you&apos;ll be asked for it here.
          </p>
        </header>

        {/* The existing add-login flow (with its OTP pre-flight) front-and-center. */}
        <NgLoginsSection />

        {/* Once a login exists, prompt the first scrape right here. */}
        {hasLogin ? (
          <div className="card text-center">
            <h2 className="text-lg font-semibold text-slate-100">You&apos;re connected</h2>
            <p className="mx-auto mt-1 max-w-prose text-sm text-slate-400">
              Now pull your history. The first run downloads every bill and PDF and can take a couple of minutes.
            </p>
            <div className="mt-3 flex justify-center">
              <RefreshButton onDone={() => { load(); loadLogins(); }} />
            </div>
          </div>
        ) : (
          <p className="text-center text-xs text-slate-500">
            Already running behind a reverse proxy or SSO? This page inherits that access gate — it&apos;s not a public
            login.
          </p>
        )}
      </div>
    );
  }

  // Cockpit shell. At ≥xl in "fit" density the page is pinned to the viewport
  // height (overflow-hidden) and the chart/bills region flexes to fill it, so the
  // PAGE never scrolls — only the bills card and chart-config popovers scroll
  // internally. Below xl (and in "comfortable" density) the page scrolls normally
  // and nothing overflows horizontally (single column < 768, 2-col 768–1280).
  const lockViewport = fit; // only meaningful at ≥xl via the responsive classes below
  return (
    <div
      className={`mx-auto flex w-full max-w-[1800px] flex-col gap-3 px-3 py-3 sm:px-5 sm:py-4 ${
        lockViewport ? 'xl:h-dvh xl:gap-2 xl:overflow-hidden xl:py-3' : ''
      }`}
    >
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-slate-50">National Grid Dashboard</h1>
            <span className="rounded-full border border-slate-700/70 bg-slate-800/50 px-2 py-0.5 font-mono text-xs text-slate-400">
              v{process.env.NEXT_PUBLIC_APP_VERSION || 'dev'}
            </span>
          </div>
          {showSwitcher ? (
            <AccountSwitcher
              groups={groups}
              selectedId={selectedAccountId}
              onSelect={(id) => patch({ selectedAccountId: id })}
            />
          ) : (
            ov?.account && (
              <p className="text-sm text-slate-400">
                Account {ov.account.accountNumber}
                {ov.account.serviceAddress ? ` · ${ov.account.serviceAddress}` : ''}
                {ov.account.companyCode ? ` · ${ov.account.companyCode}` : ''}
              </p>
            )
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link href="/settings" className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </Link>
          <RefreshButton onDone={load} />
        </div>
      </header>

      {reauthLogins.length > 0 && (
        <div className="shrink-0 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-medium">Not connected — re-authenticate</span>
              <span className="ml-2 text-xs text-rose-200/80">
                {reauthLogins.map((l) => `“${l.label}”`).join(', ')} need re-authentication. The data below is the
                last scraped state; scheduled updates for {reauthLogins.length === 1 ? 'it' : 'them'} are paused.
              </span>
            </div>
            <Link
              href="/settings"
              className="btn border border-rose-700/70 bg-rose-900/40 text-rose-200 hover:bg-rose-800/60"
            >
              Re-authenticate
            </Link>
          </div>
        </div>
      )}

      {/* Control strip: range picker + schedule pills. Compact, no-wrap-by-default. */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        {!empty && (
          <RangeControl range={prefs.range} onChange={setRange} allYms={allYms} nowYm={nowYm} />
        )}
        {ov?.schedule && (
          <div className="flex flex-wrap gap-2">
            <span className="pill">
              Next bill <strong className="text-slate-100">{dateLabel(ov.schedule.predictedNextBillDate)}</strong>
              {ov.schedule.predictedNextBillDate ? ` (${relativeFromNow(ov.schedule.predictedNextBillDate + 'T00:00:00')})` : ''}
            </span>
            <span className="pill">Checked {relativeFromNow(ov.schedule.lastCheckedAt)}</span>
            <span className="pill">Next {relativeFromNow(ov.schedule.nextCheckAt)}</span>
          </div>
        )}
      </div>

      {loading || needsSetup === null ? (
        <div className="card text-slate-400">Loading…</div>
      ) : empty ? (
        <div className="card">
          <h2 className="text-lg font-semibold text-slate-100">No data yet</h2>
          <p className="mt-1 text-sm text-slate-400">
            Click <span className="text-amber-400">Check for new bills</span> to log in to National Grid and pull your
            full history. The first run downloads every bill and PDF and can take a couple of minutes.
          </p>
        </div>
      ) : (
        <>
          {/* Compact stat strip: latest / lifetime / elec / gas / est-next, side by
              side on desktop, wrapping to a 2-col grid on narrow screens. */}
          {/* In fit density the stat strip is DENSER at ≥xl (issue #38: smaller
              padding + a smaller stat number + tighter label/sub spacing) to
              reclaim vertical space for the now-taller two-row chart grid below;
              the FILL_BODY_CLASSES height constant is tuned to this chrome.
              Comfortable density stays roomier. */}
          <div
            className={`grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 ${
              fit
                ? 'xl:[&_.card]:!p-2 xl:[&_.stat]:!text-lg xl:[&_.stat]:!leading-tight xl:[&_.card-title]:!text-[11px] xl:[&_.sub]:!mt-0'
                : ''
            }`}
          >
            <div className="card !p-3">
              <div className="card-title text-xs">Latest bill</div>
              <div className="stat text-2xl">{usd(ov?.latestBill?.totalDueAmount, dp)}</div>
              <div className="sub mt-0.5 text-[11px] text-slate-500">{dateLabel(ov?.latestBill?.statementDate)}</div>
            </div>
            <div className="card !p-3">
              <div className="card-title text-xs">Lifetime spend</div>
              <div className="stat text-2xl">{usd(ov?.lifetimeSpend, 0)}</div>
              <div className="sub mt-0.5 text-[11px] text-slate-500">across {num(ov?.billCount)} bills</div>
            </div>
            <div className="card !p-3">
              <div className="card-title text-xs">Electric rate</div>
              <div className="stat text-2xl">{rate(elecAllIn)}<span className="text-sm text-slate-500">/kWh</span></div>
              <div className="sub mt-0.5 text-[11px] text-slate-500">12-mo all-in · supply {rate(lastRow?.elecRateSupply)}</div>
            </div>
            <div className="card !p-3">
              <div className="card-title text-xs">Gas rate</div>
              <div className="stat text-2xl">{rate(gasAllIn, 2)}<span className="text-sm text-slate-500">/therm</span></div>
              <div className="sub mt-0.5 text-[11px] text-slate-500">12-mo all-in · supply {rate(lastRow?.gasRateSupply, 2)}</div>
            </div>
            {ov?.nextBillEstimate ? (
              // Compact estimate card (issue #38): just "Est. next bill", "~$X" and
              // the short range. The verbose basis + disclaimer live behind the ⓘ
              // tooltip so the word "estimate(d)" appears ONCE and the card no
              // longer pushes the stat strip taller.
              <div className="card relative !p-3">
                <div className="card-title flex items-center gap-1 text-xs">
                  Est. next bill
                  <span
                    tabIndex={0}
                    role="img"
                    aria-label={estimateTooltip(ov.nextBillEstimate.basis)}
                    title={estimateTooltip(ov.nextBillEstimate.basis)}
                    className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-600/70 text-[10px] font-semibold text-slate-400 transition hover:border-slate-400 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
                  >
                    i
                  </span>
                </div>
                <div className="stat text-2xl">~{usd(ov.nextBillEstimate.point, dp)}</div>
                <div className="sub mt-0.5 text-[11px] text-slate-500">
                  {usd(ov.nextBillEstimate.low, dp)}–{usd(ov.nextBillEstimate.high, dp)}
                </div>
              </div>
            ) : (
              <div className="hidden lg:block" />
            )}
          </div>

          {/* Main region: charts grid + bills rail. At ≥xl in "fit" density the
              charts carry explicit (100dvh-derived) heights so the three rows add
              up to the viewport with no page scroll; the bills rail STRETCHES to
              that height (grid align stretch) and scrolls internally. Below xl
              (and in comfortable density) it's a normal stacking grid that scrolls
              with the page and each chart keeps its fixed 288px height. */}
          <div className="grid min-h-0 grid-cols-1 gap-3 xl:grid-cols-[1fr_minmax(300px,360px)]">
            {/* Charts. In the paginated fit view (≥xl, fit density) we render only
                the active page's ≤4 charts in a 2-col (→ 2×2) grid that fills the
                chart region — each chart carries its own definite height from
                FILL_BODY_CLASSES so the two rows add up to the viewport with no
                page scroll — and a prev/next + dots pager sits below. Everywhere
                else it's the classic scrolling stack of every visible chart. */}
            {visibleCharts.length === 0 ? (
              <div className="card text-sm text-slate-400">
                All charts are hidden. Enable them in <Link href="/settings" className="text-amber-400">Settings</Link>.
              </div>
            ) : paginateCharts ? (
              <div className="flex min-h-0 flex-col gap-2">
                <div className="grid min-h-0 flex-1 grid-cols-2 gap-2">
                  {pagedCharts.map((id) => (
                    <div key={id}>
                      <ConfigurableChart spec={SPEC_BY_ID[id]} rows={ranged} fill height={288} />
                    </div>
                  ))}
                </div>
                {showPager && (
                  <div className="flex shrink-0 items-center justify-center gap-3 pt-0.5">
                    <button
                      type="button"
                      aria-label="Previous charts"
                      onClick={() => setPage((p) => clampPage(p - 1, pageCount))}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700/70 bg-slate-800/40 text-slate-300 transition hover:bg-slate-700 hover:text-white"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m15 18-6-6 6-6" />
                      </svg>
                    </button>
                    <div className="flex items-center gap-1.5" aria-hidden>
                      {chartPages.map((_, i) => (
                        <span
                          key={i}
                          className={`h-1.5 w-1.5 rounded-full transition ${i === activePage ? 'bg-amber-400' : 'bg-slate-600'}`}
                        />
                      ))}
                    </div>
                    <span className="min-w-[3rem] text-center text-xs tabular-nums text-slate-400">
                      {activePage + 1} / {pageCount}
                    </span>
                    <button
                      type="button"
                      aria-label="Next charts"
                      onClick={() => setPage((p) => clampPage(p + 1, pageCount))}
                      className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700/70 bg-slate-800/40 text-slate-300 transition hover:bg-slate-700 hover:text-white"
                    >
                      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m9 18 6-6-6-6" />
                      </svg>
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className={`grid min-h-0 grid-cols-1 gap-3 md:grid-cols-2 ${fit ? 'xl:gap-2' : ''}`}>
                {visibleCharts.map((id) => (
                  <div key={id} className={fit ? '' : 'min-h-[18rem]'}>
                    <ConfigurableChart spec={SPEC_BY_ID[id]} rows={ranged} fill={fit} height={288} />
                  </div>
                ))}
              </div>
            )}

            {/* Bills rail — its own scroll so the page stays put at ≥xl. */}
            <div className="card flex min-h-0 flex-col !p-0">
              <div className="flex shrink-0 items-center justify-between border-b border-slate-800/70 px-4 py-3">
                <h3 className="text-sm font-semibold text-slate-100">Bills ({rangedBills.length})</h3>
                <span className="text-[11px] text-slate-500">in range</span>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-900/95 backdrop-blur">
                    <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="py-2 pr-2">Statement</th>
                      <th className="py-2 pr-2">Period</th>
                      <th className="py-2 pl-2 text-right">Amount</th>
                      <th className="py-2 pl-2 text-right">PDF</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rangedBills.map((b) => (
                      <tr key={b.statementDate} className="border-t border-slate-800/70">
                        <td className="py-1.5 pr-2 font-medium text-slate-200">{dateLabel(b.statementDate)}</td>
                        <td className="py-1.5 pr-2 text-xs text-slate-400">
                          {b.periodFrom ? `${dateLabel(b.periodFrom)} – ${dateLabel(b.periodTo)}` : '—'}
                        </td>
                        <td className="py-1.5 pl-2 text-right text-slate-200">{usd(b.totalDueAmount, dp)}</td>
                        <td className="py-1.5 pl-2 text-right">
                          {b.hasPdf ? (
                            <a className="text-amber-400 hover:text-amber-300" href={`/api/bills/${b.statementDate}/pdf`} target="_blank" rel="noreferrer">
                              View
                            </a>
                          ) : (
                            <span className="text-slate-600">—</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {rangedBills.length === 0 && (
                      <tr><td className="py-3 text-slate-500" colSpan={4}>No bills in this range.</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              {/* Range-scoped exports live with the bills they download. */}
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-800/70 px-4 py-2 text-xs">
                <span className="text-slate-500">Export range:</span>
                <a className="text-amber-400 hover:text-amber-300" href={`/api/export?dataset=series${csvScope}`} download>CSV series</a>
                <span className="text-slate-700">·</span>
                <a className="text-amber-400 hover:text-amber-300" href={`/api/export?dataset=bills${csvScope}`} download>CSV bills</a>
                <span className="text-slate-700">·</span>
                <a className="text-amber-400 hover:text-amber-300" href={`/api/export/pdfs${pdfScope}`} download>PDFs</a>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Footer only shows when the page can scroll (no point pinning it in fit mode). */}
      <footer className={`shrink-0 pt-1 text-center text-[11px] text-slate-600 ${fit ? 'xl:hidden' : ''}`}>
        ngrid-dashboard v{process.env.NEXT_PUBLIC_APP_VERSION || 'dev'} · self-hosted · data scraped from your own
        National Grid account · not affiliated with National Grid
      </footer>
    </div>
  );
}
