'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { MonthRow } from '@/lib/chartSpec';
import { SPEC_BY_ID } from '@/lib/chartSpec';
import { seasonForwardRows } from '@/lib/prediction';
import { trailing12AllIn } from '@/lib/series';
import { clampPage, paginate } from '@/lib/cockpit';
import { usePrefs } from '@/lib/prefs';
import {
  filterByYm,
  filterBillsByYm,
  resolveRange,
  ymOfDate,
  ymToYmd,
  ymToLastYmd,
} from '@/lib/range';
import { buildAccountGroups, hasMultipleAccounts } from '@/lib/accountSwitcher';
import { ConfigurableChart } from './ConfigurableChart';
import { AccountSwitcher } from './AccountSwitcher';
import { RefreshButton } from './RefreshButton';
import { ScrapeProgressBanner } from './ScrapeProgress';
import { RangeControl } from './RangeControl';
import { NgLoginsSection } from './NgLoginsSection';
import { CockpitPager } from './CockpitPager';
import { ToolsModal, type ToolsTab } from './ToolsModal';
import { useDashboardData } from './useDashboardData';
import { dateLabel, estimateTooltip, num, rate, relativeFromNow, signedPct, usd } from '@/lib/format';

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

export function Dashboard() {
  const { prefs, patch, setRange } = usePrefs();
  // All data-loading (the three fetch lifecycles + scrape-progress polling) lives
  // in this hook; the component stays a thin orchestration shell over the result.
  const {
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
  } = useDashboardData();

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

  // Forward 12-month seasonal projection (issue #52). The projection comes from
  // the Overview (computed purely server-side); here we just APPEND its future
  // MonthRows to the cost/usage charts so the dashed series renders, and stamp the
  // first projected point onto the latest historical row as an anchor so the
  // dashed line connects to the solid history. It deliberately ignores the date
  // range (a forward projection is always shown in full). Charts that don't
  // declare a proj* series drop these rows via their own filter.
  // The projection display prefs (issue #71) gate the feature in two independent
  // halves: `seasonCharts` drives the dashed forward series + per-chart spec
  // filtering, while `seasonCard` drives the "Proj. next 12 mo" summary card.
  // Either being null means that half is hidden (the `?? null` also covers the
  // case where the server simply has no projection to show).
  const seasonCharts = prefs.showProjectionOnCharts ? (ov?.seasonProjection ?? null) : null;
  const seasonCard = prefs.showProjectionCard ? (ov?.seasonProjection ?? null) : null;
  const forwardRows: MonthRow[] = seasonCharts ? seasonForwardRows(seasonCharts) : [];
  const withForward = (base: MonthRow[]): MonthRow[] => {
    if (!forwardRows.length) return base;
    const first = forwardRows[0];
    const anchorYm = [...base].reverse().find((r) => r.kwh != null || r.therms != null)?.ym;
    const anchored = base.map((r) =>
      r.ym === anchorYm
        ? { ...r, projCost: r.billTotal, projKwh: r.kwh, projTherms: r.therms }
        : r
    );
    return [...anchored, ...forwardRows];
  };
  // Only the cost + usage charts carry the forward projected series.
  const PROJECTED_CHARTS = new Set(['cost', 'usage']);
  const chartRows = (id: string): MonthRow[] => (PROJECTED_CHARTS.has(id) ? withForward(ranged) : ranged);
  // When charts-projection is off, strip the proj* series from the cost/usage
  // specs so their legend entries and config checkboxes disappear too (issue #71)
  // — not just the data. The spec is declarative, so we filter a shallow copy.
  const specFor = (id: string) => {
    const s = SPEC_BY_ID[id];
    if (seasonCharts || !PROJECTED_CHARTS.has(id)) return s;
    return { ...s, series: s.series.filter((ser) => !ser.key.startsWith('proj')) };
  };

  // The export links scope to BOTH the account and the on-screen date range so a
  // download matches what's visible. CSV exports take ym integers (from/to);
  // the PDF bundle takes a full-month ISO date span (its existing contract).
  const acctQuery = selectedAccountId != null ? `&accountId=${selectedAccountId}` : '';
  const csvScope = `&from=${resolved.fromYm}&to=${resolved.toYm}${acctQuery}`;
  const pdfScope = `?from=${ymToYmd(resolved.fromYm)}&to=${ymToLastYmd(resolved.toYm)}${acctQuery}`;

  const visibleCharts = prefs.order.filter((id) => prefs.charts[id]?.visible && SPEC_BY_ID[id]);
  const fit = prefs.density === 'fit';

  // "vs last year (normalized)" card (issue #47). Latest-month-vs-same-month-a-
  // year-ago, weather-normalized, per fuel — computed server-side (ov.latestYoy).
  // We show whichever fuels have a result; the card self-hides only when neither
  // fuel matched a prior-year month (like the other optional cards). The number
  // shown is the normalized (intensity) change, the honest "did I use less" figure.
  const yoyCard = ov?.latestYoy ?? null;
  const yoyCardFuels = yoyCard ? [yoyCard.elec, yoyCard.gas].filter((r) => r != null) : [];
  const showYoyCard = yoyCardFuels.length > 0;
  // Green/red tint for a normalized YoY delta: LOWER usage than last year is BETTER
  // (emerald), higher is WORSE (rose), ~flat or null is neutral (slate). A tiny
  // epsilon around 0 counts as flat. Matches the budget card's emerald/rose tokens
  // and the Compare tool's normalized-cost coloring. Presentation only.
  const yoyDeltaClass = (pct: number | null | undefined): string =>
    pct == null || Math.abs(pct) < 0.005
      ? 'text-slate-200'
      : pct < 0
        ? 'text-emerald-300'
        : 'text-rose-300';

  // Budget / annual-spend target card (issue #46). Always-visible when a target
  // is set: spent so far (currentCharges), the projected end-of-window total with
  // its band, an on/over/under status pill, and a progress bar. Self-hides when no
  // target is set (the subtle "set a budget" affordance covers that case). All the
  // arithmetic happened server-side (ov.budget); this only renders it.
  const budget = ov?.budget ?? null;

  // On-demand Tools modal (UX refactor): the interactive Compare-periods (#47) and
  // Supply what-if (#48) tools no longer sit always-visible below the strip — they
  // live in a centered modal opened by the header "Tools" button or the
  // vs-last-year card. `toolsTab` is the tab to open to (the card opens Compare).
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsTab, setToolsTab] = useState<ToolsTab>('compare');
  const openTools = (tab: ToolsTab) => {
    setToolsTab(tab);
    setToolsOpen(true);
  };

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
              <RefreshButton
                onDone={() => { load(); loadLogins(); }}
                onStarted={trackRun}
                running={scraping}
              />
            </div>
            {/* The long first run shows its live progress right here so it never
                looks frozen while logging in, pulling history, and PDFs. */}
            <div className="mt-3 text-left">
              <ScrapeProgressBanner run={progressRun} onRetry={retryScrape} onDismiss={dismissProgress} />
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
          {/* Tools button (UX refactor): opens the interactive Compare / what-if
              tools in an on-demand modal instead of cluttering the dashboard body.
              Hidden until there's data to analyse. */}
          {!empty && (
            <button
              type="button"
              onClick={() => openTools('compare')}
              className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.3 2.3a1.5 1.5 0 0 1-2.1-2.1z" />
              </svg>
              Tools
            </button>
          )}
          <Link href="/settings" className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </Link>
          <RefreshButton onDone={load} onStarted={trackRun} running={scraping} />
        </div>
      </header>

      {/* Live scrape-progress indicator (issue #40): a prominent animated banner
          shown whenever a scrape is in flight, then a brief success/error state. */}
      <ScrapeProgressBanner run={progressRun} onRetry={retryScrape} onDismiss={dismissProgress} />

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
          {/* lg column count tracks the number of cards actually rendered (issue
              #71): 4 fixed + the optional est-next, proj, carbon and vs-last-year
              cards. We map to an explicit literal so the class string is visible to
              Tailwind's JIT. */}
          <div
            className={`grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 ${
              { 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'lg:grid-cols-6', 7: 'lg:grid-cols-7', 8: 'lg:grid-cols-8', 9: 'lg:grid-cols-9' }[
                4 + (ov?.nextBillEstimate ? 1 : 0) + (seasonCard ? 1 : 0) + (ov?.emissions ? 1 : 0) + (showYoyCard ? 1 : 0) + (budget ? 1 : 0)
              ]
            } ${
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
            ) : null}
            {/* Annual-total readout (issue #52): the sum of the next 12 projected
                bill periods, with its combined band. Clearly labelled a
                climatological PROJECTION, not a forecast — the verbose basis lives
                behind the ⓘ tooltip so the word "projection" appears once. */}
            {seasonCard ? (
              <div className="card relative !p-3">
                <div className="card-title flex items-center gap-1 text-xs">
                  Proj. next 12 mo
                  <span
                    tabIndex={0}
                    role="img"
                    aria-label={`Climatological projection (degree-day normals × current all-in rates) for the next 12 bill periods — ${seasonCard.basis}. Not a forecast, not a real charge.`}
                    title={`Climatological projection (degree-day normals × current all-in rates) for the next 12 bill periods — ${seasonCard.basis}. Not a forecast, not a real charge.`}
                    className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-600/70 text-[10px] font-semibold text-slate-400 transition hover:border-slate-400 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-violet-500/60"
                  >
                    i
                  </span>
                </div>
                <div className="stat text-2xl">~{usd(seasonCard.annual.point, 0)}</div>
                <div className="sub mt-0.5 text-[11px] text-slate-500">
                  {usd(seasonCard.annual.low, 0)}–{usd(seasonCard.annual.high, 0)} · projection
                </div>
              </div>
            ) : null}
            {/* Carbon-footprint estimate (issue #49): trailing-12 combined CO2e in
                kg, with a friendly equivalence and the location-based-ESTIMATE
                caveat behind the ⓘ tooltip so the card stays compact. Never a
                cost number. */}
            {ov?.emissions ? (
              <div className="card relative !p-3">
                <div className="card-title flex items-center gap-1 text-xs">
                  Carbon (12 mo)
                  <span
                    tabIndex={0}
                    role="img"
                    aria-label="Location-based estimate: your kWh and therms multiplied by published EPA average emission factors (electricity via the eGRID subregion grid factor, gas at 5.3 kg CO2e/therm). It reflects the regional grid mix, not your specific supply plan. Set gridEmissionFactor in Settings to override."
                    title="Location-based estimate: your kWh and therms multiplied by published EPA average emission factors (electricity via the eGRID subregion grid factor, gas at 5.3 kg CO2e/therm). It reflects the regional grid mix, not your specific supply plan. Set gridEmissionFactor in Settings to override."
                    className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-600/70 text-[10px] font-semibold text-slate-400 transition hover:border-slate-400 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500/60"
                  >
                    i
                  </span>
                </div>
                <div className="stat text-2xl">~{num(Math.round(ov.emissions.totalKg))}<span className="text-sm text-slate-500"> kg CO₂e</span></div>
                <div className="sub mt-0.5 text-[11px] text-slate-500">
                  ≈ {num(Math.round(ov.emissions.gallonsGasoline))} gal gas · {num(Math.round(ov.emissions.treeYears))} tree-yrs · estimate
                </div>
              </div>
            ) : null}
            {/* vs-last-year (normalized) card (issue #47): the always-visible fix
                for the old density-hidden YoyPanel. Shows the weather-normalized
                usage change for the latest month vs the same calendar month a year
                ago, per fuel ("Elec +2% · Gas −5%"). Renders in BOTH densities (it
                lives in this shared top strip). The number is the honest normalized
                (intensity) change; the full breakdown lives in the Compare tool
                below. Self-hides when no fuel has a prior-year match. */}
            {showYoyCard ? (
              // Clickable: opens the Tools modal straight to the Compare-periods
              // tab for the full breakdown. role=button + keyboard activation so
              // it's reachable without a mouse.
              <div
                role="button"
                tabIndex={0}
                onClick={() => openTools('compare')}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openTools('compare');
                  }
                }}
                className="card relative cursor-pointer !p-3 transition hover:border-slate-600 hover:bg-slate-800/60 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
              >
                <div className="card-title flex items-center gap-1 text-xs">
                  vs last year
                  <span
                    tabIndex={0}
                    role="img"
                    aria-label="Weather-normalized usage change for the latest month vs the same calendar month one year earlier, per fuel. It compares usage per degree-day so a warmer/colder month doesn't masquerade as using less/more — the honest 'did I actually use less' number. Use the Compare periods tool below for the full breakdown and other windows. Not a real charge."
                    title="Weather-normalized usage change for the latest month vs the same calendar month one year earlier, per fuel. It compares usage per degree-day so a warmer/colder month doesn't masquerade as using less/more — the honest 'did I actually use less' number. Use the Compare periods tool below for the full breakdown and other windows. Not a real charge."
                    className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-600/70 text-[10px] font-semibold text-slate-400 transition hover:border-slate-400 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
                  >
                    i
                  </span>
                </div>
                <div className="stat flex items-baseline gap-2 text-2xl">
                  {yoyCard?.elec ? (
                    <span><span className="text-sm text-amber-400">Elec</span>{' '}
                      <span className={yoyDeltaClass(yoyCard.elec.normalizedPct)}>{signedPct(yoyCard.elec.normalizedPct)}</span>
                    </span>
                  ) : null}
                  {yoyCard?.gas ? (
                    <span><span className="text-sm text-sky-400">Gas</span>{' '}
                      <span className={yoyDeltaClass(yoyCard.gas.normalizedPct)}>{signedPct(yoyCard.gas.normalizedPct)}</span>
                    </span>
                  ) : null}
                </div>
                <div className="sub mt-0.5 text-[11px] text-slate-500">normalized vs last yr · click to compare</div>
              </div>
            ) : null}
            {/* Budget / annual-spend target (issue #46): always-visible when a
                target is set. Shows projected end-of-window total vs the target,
                an on-track / over / under status, and a progress bar (spent solid,
                projected-remaining lighter). When NO target is set, a subtle "set
                a budget" affordance links to Settings. The verbose detail (spent,
                window, band, remaining periods) lives behind the ⓘ tooltip. All
                math is server-side (ov.budget). */}
            {budget ? (() => {
              const { spent, projected, projectedLow, projectedHigh, target, delta, status, window } = budget;
              const statusColor =
                status === 'over' ? 'text-rose-300' : status === 'under' ? 'text-emerald-300' : 'text-slate-200';
              const statusLabel =
                status === 'over' ? `over by ${usd(Math.abs(delta), 0)}`
                  : status === 'under' ? `under by ${usd(Math.abs(delta), 0)}`
                    : 'on track';
              // Progress bar: spent (solid) + projected-remaining (lighter), as a
              // fraction of max(target, projected) so an over-budget projection
              // still fills the bar and overflows visibly into the rose tint.
              const denom = Math.max(target, projected, 1);
              const spentPct = Math.min(100, (spent / denom) * 100);
              const remPct = Math.min(100 - spentPct, (Math.max(0, projected - spent) / denom) * 100);
              const targetPct = Math.min(100, (target / denom) * 100);
              const fromY = Math.floor(window.fromYm / 100);
              return (
                <div className="card relative !p-3">
                  <div className="card-title flex items-center gap-1 text-xs">
                    Budget {fromY}
                    <span
                      tabIndex={0}
                      role="img"
                      aria-label={`Spent ${usd(spent, 0)} of your ${usd(target, 0)} ${fromY} target so far; projected end-of-year total ${usd(projected, 0)} (range ${usd(projectedLow, 0)}–${usd(projectedHigh, 0)}). Spent is the sum of this year's bills' actual period charges (currentCharges, the PDF source of truth — never the statement amount due); the projected remainder reuses the next-bill estimate and the seasonal 12-month projection. Set or change the target in Settings. Not a real charge.`}
                      title={`Spent ${usd(spent, 0)} of your ${usd(target, 0)} ${fromY} target so far; projected end-of-year total ${usd(projected, 0)} (range ${usd(projectedLow, 0)}–${usd(projectedHigh, 0)}). Spent is the sum of this year's bills' actual period charges (currentCharges, the PDF source of truth — never the statement amount due); the projected remainder reuses the next-bill estimate and the seasonal 12-month projection. Set or change the target in Settings. Not a real charge.`}
                      className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-600/70 text-[10px] font-semibold text-slate-400 transition hover:border-slate-400 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
                    >
                      i
                    </span>
                  </div>
                  <div className="stat text-2xl">
                    ~{usd(projected, 0)}<span className="text-sm text-slate-500"> / {usd(target, 0)}</span>
                  </div>
                  {/* Progress bar: spent solid, projected-remaining lighter, with a
                      target tick. Overflows into a rose tint when over budget. */}
                  <div className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                    <div className="absolute inset-y-0 left-0 flex">
                      <div className={status === 'over' ? 'bg-rose-500/80' : 'bg-amber-400'} style={{ width: `${spentPct}%` }} />
                      <div className={status === 'over' ? 'bg-rose-400/40' : 'bg-amber-400/35'} style={{ width: `${remPct}%` }} />
                    </div>
                    <div className="absolute inset-y-0 w-px bg-slate-300/80" style={{ left: `${targetPct}%` }} />
                  </div>
                  <div className={`sub mt-0.5 text-[11px] ${statusColor}`}>
                    {statusLabel} · {usd(spent, 0)} spent
                  </div>
                </div>
              );
            })() : null}
          </div>

          {/* Subtle "set a budget" affordance (issue #46) when no target is set —
              links to Settings where the target input lives. Hidden once a target
              is set (the budget card replaces it). */}
          {!budget && !empty ? (
            <div className="shrink-0 text-[11px] text-slate-500">
              Want to track an annual spending target?{' '}
              <Link href="/settings" className="text-amber-400 hover:underline">Set a budget</Link>.
            </div>
          ) : null}

          {/* The interactive Compare-periods (#47) and Supply what-if (#48) tools
              no longer render inline here — they were powerful but rarely-used
              clutter. They now live in the on-demand Tools modal (header "Tools"
              button; the vs-last-year card opens it straight to Compare). The modal
              itself is rendered once at the end of the component. */}

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
                      <ConfigurableChart spec={specFor(id)} rows={chartRows(id)} fill height={288} />
                    </div>
                  ))}
                </div>
                {showPager && (
                  <CockpitPager pageCount={pageCount} activePage={activePage} setPage={setPage} />
                )}
              </div>
            ) : (
              <div className={`grid min-h-0 grid-cols-1 gap-3 md:grid-cols-2 ${fit ? 'xl:gap-2' : ''}`}>
                {visibleCharts.map((id) => (
                  <div key={id} className={fit ? '' : 'min-h-[18rem]'}>
                    <ConfigurableChart spec={specFor(id)} rows={chartRows(id)} fill={fit} height={288} />
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

      {/* On-demand Tools modal: hosts the Compare-periods / Supply what-if tools as
          tabs. ComparePeriods gets the full series (it windows internally); the
          what-if back-tests the on-screen range — same data split as the old inline
          renders, so the tools behave identically. */}
      <ToolsModal
        open={toolsOpen}
        onClose={() => setToolsOpen(false)}
        initialTab={toolsTab}
        rows={rows}
        rangedRows={ranged}
        currencyDecimals={dp}
      />

      {/* Footer only shows when the page can scroll (no point pinning it in fit mode). */}
      <footer className={`shrink-0 pt-1 text-center text-[11px] text-slate-600 ${fit ? 'xl:hidden' : ''}`}>
        ngrid-dashboard v{process.env.NEXT_PUBLIC_APP_VERSION || 'dev'} · self-hosted · data scraped from your own
        National Grid account · not affiliated with National Grid
      </footer>
    </div>
  );
}
