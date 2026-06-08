'use client';

import Link from 'next/link';
import { Fragment, useEffect, useRef, useState } from 'react';
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
import { AccountSwitcher } from './AccountSwitcher';
import { RefreshButton } from './RefreshButton';
import { ScrapeProgressBanner } from './ScrapeProgress';
import { RangeControl } from './RangeControl';
import { NgLoginsSection } from './NgLoginsSection';
import { CockpitPager } from './CockpitPager';
import { ToolsModal, type ToolsTab } from './ToolsModal';
import { NotificationsBell } from './NotificationsBell';
import { useDashboardData } from './useDashboardData';
import { dateLabel, relativeFromNow, usd } from '@/lib/format';
import { STAT_SPECS, type StatData } from '@/lib/widgets/statSpec';
import { chartWidgetType, getWidget, statWidgetType, type WidgetHost } from '@/lib/widgets/registry';

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
    dashboardLayout,
  } = useDashboardData();
  // Server-side dashboard DEFINITION (Phase D, #96): the chart order, per-chart
  // config, and visibility now live on the server (per account), loaded async.
  // While it's loading we render a skeleton for the chart region (see below) so
  // there's NO first-paint flash of the default order/config snapping to the
  // user's saved one — the old localStorage path was synchronous and never
  // flashed, so this preserves that. `layout` is null until the first fetch
  // resolves; we guard the chart reads on it.
  const { layout, layoutLoading, updateChart: updateLayoutChart, reorder } = dashboardLayout;

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
  // The chart-projection pref (issue #71) gates the dashed forward series + the
  // per-chart spec filtering. (The old "Proj. next 12 mo" summary card, gated by
  // the separate showProjectionCard pref, was merged into the Budget card → Budget
  // tab — its annual total now lives in that tool, always available regardless of
  // this chart toggle.) null means the series is hidden (the `?? null` also covers
  // the case where the server simply has no projection to show).
  const seasonCharts = prefs.showProjectionOnCharts ? (ov?.seasonProjection ?? null) : null;
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

  // The visible charts, IN ORDER, now come from the SERVER layout (Phase D, #96)
  // — same filter as before (visible flag + a known spec), just sourced from
  // `layout.{order,widgetConfig}` instead of `prefs.{order,charts}`. Empty while
  // the layout is still loading so we render the skeleton, not a stale set.
  const visibleCharts = layout
    ? layout.order.filter((id) => layout.widgetConfig[id]?.visible && SPEC_BY_ID[id])
    : [];
  const fit = prefs.density === 'fit';

  // Budget / annual-spend target card (issue #46). The redesign merges the old
  // standalone Budget card AND the "Proj. next 12 mo" card into ONE compact,
  // CLICKABLE Budget card. The arithmetic happened server-side (ov.budget); the
  // value-rendering now lives in the budget StatSpec/StatCard. We still read it
  // directly here for the no-target "set a budget" affordance and the Tools modal.
  const budget = ov?.budget ?? null;

  // Stat-strip widgets (Phase A, issue #93). The 8 cards that used to be ~190
  // lines of hardcoded JSX are now declarative StatSpecs rendered through the
  // widget registry. StatData is the exact bag the cards read (the trailing12
  // rate calcs + lastRow find above stay where they are — pure); each StatSpec's
  // pure isVisible predicate mirrors the card's old guard. We filter to the
  // visible specs here, in their declared order (4 fixed + the optional
  // est-next/carbon/vs-last-year/budget), and the count drives the grid columns.
  const statData: StatData = { ov, elecAllIn, gasAllIn, lastRow, currencyDecimals: dp };
  const visibleStats = STAT_SPECS.filter((s) => s.isVisible(statData));

  // Header notifications bell (notification-log feature). The old inline amber
  // anomaly banner (#45) is superseded by a dropdown over the persistent
  // SERVER-SIDE notification log — the SAME events the email/webhook/ntfy channels
  // send: usage/cost anomalies (#45) AND new-bill alerts (#7). The bell fetches its
  // own log (GET /api/notifications, scoped to the selected account) with read/
  // unread and a "hide read" filter, so the dashboard no longer derives or passes
  // the items in. We still hand it the loaded bills for the new-bill detail's PDF
  // link.

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

  // The host context the widget registry renders against (Phase A #93 / Phase B
  // #94). Chart widgets now declare a `dataset` and resolve it through the host;
  // for `'monthly'` the resolver delegates to the SAME chartRows() adapter (the
  // #71 spec-stripping + #52/#71 forward-projection append are UNCHANGED — that
  // logic still lives here, in one place). The spec to draw still comes from
  // specFor (it carries the proj*-series stripping). `'monthly'` is the only id a
  // Phase-B chart asks for; resolving any other is a wiring bug, so we throw.
  // `chartFill` is set per chart code-path below (the paginated fit grid always
  // fills; the stacking grid fills only in fit density) — exactly as the two old
  // ConfigurableChart call sites passed it — so we build the host with a
  // caller-supplied fill.
  const resolveDataset: WidgetHost['resolveDataset'] = (dataset, id) => {
    if (dataset === 'monthly') return chartRows(id) as never;
    throw new Error(`Dataset '${dataset}' is not resolvable in Phase B`);
  };
  const widgetHost = (chartFill: boolean): WidgetHost => ({
    resolveDataset,
    specFor,
    chartFill,
    chartHeight: 288,
    // Phase D (#96): a chart's config now comes from the SERVER layout and its
    // in-chart Customize edits write back through the layout hook (optimistic +
    // PUT). `layout` is non-null wherever charts render (we gate on it below), so
    // configFor resolves the saved config; updateLayoutChart persists the change.
    configFor: (id) => layout?.widgetConfig[id],
    onChartChange: updateLayoutChart,
    statData,
    openTools,
  });

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

  // First-run convenience: once the first login is verified during setup, kick the
  // initial scrape automatically (exactly once) so the user doesn't have to hunt
  // for a button — the "You're connected" card then shows live progress and, on
  // success, the populated dashboard replaces this setup view. The button there
  // stays as an explicit retry. The ref resets if the login is removed, so
  // re-adding one re-arms the auto-scrape. The `!progressRun` guard skips it when a
  // run is already in flight (e.g. the page reloaded mid-scrape).
  const autoScrapeStarted = useRef(false);
  useEffect(() => {
    if (!hasLogin) {
      autoScrapeStarted.current = false;
      return;
    }
    if (needsSetup && !progressRun && !autoScrapeStarted.current) {
      autoScrapeStarted.current = true;
      retryScrape();
    }
  }, [needsSetup, hasLogin, progressRun, retryScrape]);
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
            Let&apos;s get set up. Add your National Grid login below — it&apos;s stored securely (encrypted) and used
            only to pull your own account&apos;s bills and usage. Adding it signs in once to check it works; if National
            Grid sends a one-time code you&apos;ll be asked for it here.
          </p>
        </header>

        {/* The existing add-login flow (with its OTP pre-flight) front-and-center.
            onChanged advances this setup view as soon as a login is verified (no
            manual reload) — which both reveals the card below and arms the
            auto-scrape effect above. */}
        <NgLoginsSection onChanged={loadLogins} />

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
          {/* Notifications bell (notifications-dropdown feature): the in-app mirror
              of the email/webhook/ntfy alerts — anomalies (#45) + new-bill (#7) —
              with an unread-count badge and a dismissable dropdown. Hidden until
              there's data (and thus a possible bill/anomaly) to surface. */}
          {!empty && (
            <NotificationsBell
              accountId={selectedAccountId}
              bills={bills}
              onOpenCompare={() => openTools('compare')}
            />
          )}
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
          {/* The 8 cards now render through the widget registry (Phase A, issue
              #93) as declarative StatSpecs — the ~190 lines of hardcoded card JSX
              that used to live here moved into lib/widgets/statSpec.ts (pure
              selectors) + components/widgets/StatCard.tsx (the shared/bespoke
              renderers), with byte-identical markup. We render `visibleStats` (the
              specs whose isVisible passed, in their declared order: 4 fixed + the
              optional est-next/carbon/vs-last-year/budget) through the registry.

              The lg column count still tracks the number of cards actually
              rendered (issue #71) — now derived from `visibleStats.length` — and
              still maps to an explicit literal so the class string is visible to
              Tailwind's JIT. The fit-density denser overrides on the wrapper are
              unchanged. */}
          <div
            className={`grid shrink-0 grid-cols-2 gap-2 sm:grid-cols-3 ${
              { 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'lg:grid-cols-6', 7: 'lg:grid-cols-7', 8: 'lg:grid-cols-8', 9: 'lg:grid-cols-9' }[
                visibleStats.length
              ]
            } ${
              fit
                ? 'xl:[&_.card]:!p-2 xl:[&_.stat]:!text-lg xl:[&_.stat]:!leading-tight xl:[&_.card-title]:!text-[11px] xl:[&_.sub]:!mt-0'
                : ''
            }`}
          >
            {visibleStats.map((s) => (
              // Fragment (not a wrapper div) so each card stays a DIRECT grid
              // child exactly as before — no extra DOM node that would break the
              // grid layout or the `[&_.card]` density overrides.
              <Fragment key={s.id}>{getWidget(statWidgetType(s.id)).render(widgetHost(fit))}</Fragment>
            ))}
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

          {/* The usage/cost anomaly callout (#45) that used to render here was
              superseded by the header notifications bell — anomalies now appear as
              dismissable items in that dropdown alongside the new-bill alert. */}

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
            {layoutLoading || !layout ? (
              // SKELETON (Phase D, #96): the chart DEFINITION (order/config/
              // visibility) loads async from the server, so we hold a neutral
              // skeleton card here until it resolves — never a flash of the default
              // layout that snaps to the user's saved one (the old localStorage
              // path was synchronous and never flashed; this preserves that). The
              // surrounding chrome (header, stat strip, range, bills rail) is
              // unaffected — only the chart region waits on the layout.
              <div className="card flex min-h-[18rem] items-center justify-center text-sm text-slate-500">
                <span className="inline-flex items-center gap-2">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-slate-600" />
                  Loading your dashboard…
                </span>
              </div>
            ) : visibleCharts.length === 0 ? (
              <div className="card text-sm text-slate-400">
                All charts are hidden. Enable them in <Link href="/settings" className="text-amber-400">Settings</Link>.
              </div>
            ) : paginateCharts ? (
              <div className="flex min-h-0 flex-col gap-2">
                <div className="grid min-h-0 flex-1 grid-cols-2 gap-2">
                  {pagedCharts.map((id) => (
                    // Chart-widgets (Phase A, #93): the registry render wraps the
                    // SAME ConfigurableChart with the SAME specFor/chartRows
                    // adapters — output is byte-identical. The paginated fit grid
                    // always fills (fill=true), as before.
                    <div key={id}>{getWidget(chartWidgetType(id)).render(widgetHost(true))}</div>
                  ))}
                </div>
                {showPager && (
                  <CockpitPager pageCount={pageCount} activePage={activePage} setPage={setPage} />
                )}
              </div>
            ) : (
              <div className={`grid min-h-0 grid-cols-1 gap-3 md:grid-cols-2 ${fit ? 'xl:gap-2' : ''}`}>
                {visibleCharts.map((id) => (
                  // Classic stacking grid: the chart-widget fills only in fit
                  // density (fill={fit}), exactly as the old call site did.
                  <div key={id} className={fit ? '' : 'min-h-[18rem]'}>
                    {getWidget(chartWidgetType(id)).render(widgetHost(fit))}
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
        budget={budget}
        seasonProjection={ov?.seasonProjection ?? null}
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
