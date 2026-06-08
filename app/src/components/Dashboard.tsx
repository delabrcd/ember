'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MonthRow } from '@/lib/chartSpec';
import { SPEC_BY_ID } from '@/lib/chartSpec';
import { seasonForwardRows } from '@/lib/prediction';
import { trailing12AllIn } from '@/lib/series';
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
import { ToolsModal, type ToolsTab } from './ToolsModal';
import { NotificationsBell } from './NotificationsBell';
import { useDashboardData } from './useDashboardData';
import { dateLabel, relativeFromNow } from '@/lib/format';
import { STAT_SPECS, type StatData } from '@/lib/widgets/statSpec';
import {
  BILLS_PANEL_TYPE,
  chartWidgetType,
  getWidget,
  statWidgetType,
  type WidgetHost,
} from '@/lib/widgets/registry';
import { WidgetLayout } from './WidgetLayout';
import { WidgetPalette, type PaletteGroup } from './WidgetPalette';
import { FIT_BREAKPOINT, generateDefaultPlacements, type Breakpoint, type Placement } from '@/lib/layoutEngine';

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
  // Phase E (#73) adds the per-breakpoint `layouts` placements to the same blob.
  // While it's loading we render a skeleton for the grid (see below) so there's
  // NO first-paint flash of the default snapping to the saved layout.
  const { layout, layoutLoading, updateChart: updateLayoutChart, setPlacements, setPinnedStatStrip } = dashboardLayout;

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

  // Forward 12-month seasonal projection (issue #52). Appended to the cost/usage
  // charts so the dashed forward series renders. (Unchanged from before Phase E.)
  const seasonCharts = prefs.showProjectionOnCharts ? (ov?.seasonProjection ?? null) : null;
  const forwardRows: MonthRow[] = seasonCharts ? seasonForwardRows(seasonCharts) : [];
  const withForward = (base: MonthRow[]): MonthRow[] => {
    if (!forwardRows.length) return base;
    const anchorYm = [...base].reverse().find((r) => r.kwh != null || r.therms != null)?.ym;
    const anchored = base.map((r) =>
      r.ym === anchorYm
        ? { ...r, projCost: r.billTotal, projKwh: r.kwh, projTherms: r.therms }
        : r
    );
    return [...anchored, ...forwardRows];
  };
  const PROJECTED_CHARTS = new Set(['cost', 'usage']);
  const chartRows = (id: string): MonthRow[] => (PROJECTED_CHARTS.has(id) ? withForward(ranged) : ranged);
  const specFor = (id: string) => {
    const s = SPEC_BY_ID[id];
    if (seasonCharts || !PROJECTED_CHARTS.has(id)) return s;
    return { ...s, series: s.series.filter((ser) => !ser.key.startsWith('proj')) };
  };

  // The export links scope to BOTH the account and the on-screen date range.
  const acctQuery = selectedAccountId != null ? `&accountId=${selectedAccountId}` : '';
  const csvScope = `&from=${resolved.fromYm}&to=${resolved.toYm}${acctQuery}`;
  const pdfScope = `?from=${ymToYmd(resolved.fromYm)}&to=${ymToLastYmd(resolved.toYm)}${acctQuery}`;

  // Budget / annual-spend target card (issue #46). Read here for the no-target
  // "set a budget" affordance and the Tools modal.
  const budget = ov?.budget ?? null;

  // Stat-strip widgets (Phase A, issue #93). The visible specs (their isVisible
  // predicate passed) in declared order. StatData is the exact bag the cards read.
  const statData: StatData = useMemo(
    () => ({ ov, elecAllIn, gasAllIn, lastRow, currencyDecimals: dp }),
    [ov, elecAllIn, gasAllIn, lastRow, dp]
  );
  const visibleStats = STAT_SPECS.filter((s) => s.isVisible(statData));

  // On-demand Tools modal (UX refactor). `toolsTab` is the tab to open to.
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsTab, setToolsTab] = useState<ToolsTab>('compare');
  const openTools = (tab: ToolsTab) => {
    setToolsTab(tab);
    setToolsOpen(true);
  };

  // The host context the widget registry renders against (Phase A–E). Chart
  // widgets resolve their dataset through the host (the #71 spec-stripping +
  // #52/#71 forward-projection append still live here); stat widgets read the
  // StatData bag; the bills panel reads the range-filtered bills + export scopes.
  const resolveDataset: WidgetHost['resolveDataset'] = (dataset, id) => {
    if (dataset === 'monthly') return chartRows(id) as never;
    throw new Error(`Dataset '${dataset}' is not resolvable in Phase B`);
  };
  // In the grid every widget FILLS its placed cell (the RGL row sizing — fit or
  // fixed — owns the height now), so chartFill is always true and chartHeight is
  // irrelevant (ConfigurableChart uses the fill path). This is the runtime no-
  // scroll fit replacing FILL_BODY_CLASSES: the cell height comes from RGL's
  // computed rowHeight, and the chart fills it at 100%.
  const widgetHost: WidgetHost = {
    resolveDataset,
    specFor,
    chartFill: true,
    chartHeight: 288,
    configFor: (id) => layout?.widgetConfig[id],
    onChartChange: updateLayoutChart,
    statData,
    openTools,
    billsData: { rangedBills, currencyDecimals: dp, csvScope, pdfScope },
  };

  // ---- The placed-widget set (Phase E, #73) ----
  // Which widgets are on the grid. The saved `layouts` placements are the
  // AUTHORITY once they exist: a widget shows iff it's present in the saved lg
  // placements (and, for charts, also still passes Phase-D visibility + has a
  // spec). Before anything is saved, EVERYTHING available shows — i.e. today's
  // default dashboard (acceptance #1, #4). Removing a widget persists it absent;
  // adding re-inserts it.
  //
  // The full available universe per category:
  //   • charts — every chart id whose Phase-D config says `visible` (Settings /
  //     the in-chart toggle still own per-chart visibility) and that has a spec,
  //     in the user's saved order.
  //   • stats  — every stat whose isVisible predicate passed (data-driven; same
  //     guard as today).
  //   • panels — the single bills panel (always available when there's data).
  const availableCharts = layout
    ? layout.order.filter((id) => layout.widgetConfig[id]?.visible && SPEC_BY_ID[id]).map(chartWidgetType)
    : [];
  const availableStats = visibleStats.map((s) => statWidgetType(s.id));
  const availablePanels = [BILLS_PANEL_TYPE];

  // The set of widget types the SAVED layout places (lg breakpoint). null (vs an
  // empty set) means "no layout saved yet" → show everything (today's default,
  // acceptance #1/#4). Once saved, it's the authority for STAT/PANEL membership.
  const savedTypes: Set<string> | null = useMemo(() => {
    const lg = layout?.layouts?.[FIT_BREAKPOINT];
    if (!lg || !Array.isArray(lg)) return null;
    return new Set(lg.map((p: Placement) => p.i));
  }, [layout]);

  // What's PLACED, per category, reconciling the two removal signals:
  //   • CHARTS — visibility is owned by Phase-D `widgetConfig.visible` (Settings +
  //     the in-chart toggle), so `availableCharts` already excludes removed/hidden
  //     charts; a chart NEWLY added in a later app version is absent from the saved
  //     placements but still `visible`, and WidgetLayout's mergePlacements appends
  //     it at its default slot — so it SHOWS (the mergeOrder "append new" rule).
  //     Hence charts use `availableCharts` directly, NOT the savedTypes gate.
  //   • STATS / PANELS — have no per-widget visibility flag, so placement ABSENCE
  //     is their only "removed" signal: gate them on savedTypes (null → all shown,
  //     pre-customization). Trade-off: a stat card added in a FUTURE app version
  //     would be hidden for a user with a saved layout until they add it from the
  //     palette. That's acceptable (stat cards are rarely added and are one click
  //     to restore) and keeps remove working without a new persisted field.
  const isPlaced = (type: string) => savedTypes === null || savedTypes.has(type);
  const statIds = availableStats.filter(isPlaced);
  const chartIds = availableCharts;
  const panelIds = availablePanels.filter(isPlaced);

  // Customize mode (Phase E). A header Customize/Done toggle; only meaningful at
  // ≥xl in fit (the grid is interactive everywhere, but the palette + the cockpit
  // shine on desktop). Off by default — the default view is the static dashboard.
  const [customizing, setCustomizing] = useState(false);
  const fit = prefs.density === 'fit';

  // Add/remove a widget. Both edit the SAVED placements: removing strips the type
  // from every breakpoint; adding re-inserts it at its default slot (handled by
  // WidgetLayout's merge against fresh defaults — adding just means "no longer
  // removed", so we drop it from the removed set by ensuring it's in placements).
  // For CHARTS we also keep Phase-D visibility in sync (so Settings agrees):
  // removing a chart sets visible:false, adding sets visible:true.
  const addWidget = (type: string) => {
    if (type.startsWith('chart:')) {
      const id = type.slice('chart:'.length);
      updateLayoutChart(id, { visible: true });
    }
    // Ensure it's considered placed: if we have a saved set, re-add by writing a
    // placements blob that includes it (WidgetLayout regenerates the slot). The
    // simplest correct move is to clear the saved set's exclusion by persisting a
    // placements blob WITHOUT this type's absence — i.e. let WidgetLayout's next
    // merge (which appends newly-available widgets) place it. We trigger that by
    // bumping placements minimally: append a default lg placement for the type.
    addToPlacements(type);
  };
  const removeWidget = (type: string) => {
    if (type.startsWith('chart:')) {
      const id = type.slice('chart:'.length);
      updateLayoutChart(id, { visible: false });
    }
    removeFromPlacements(type);
  };

  // Mutate the saved placements to add/remove a type across all breakpoints. When
  // no layout is saved yet, removing materializes the current default minus the
  // type (so the removal sticks); adding from that state is a no-op (all shown).
  const removeFromPlacements = (type: string) => {
    const cur = layout?.layouts;
    if (!cur) {
      // No saved placements yet: materialize "everything except `type`" by
      // letting WidgetLayout persist its default for the reduced set on next
      // render — we trigger that by writing an empty-but-defined blob keyed lg so
      // savedTypes becomes non-null. Simpler: write the current default lg set
      // (all available) minus this type; the other breakpoints regenerate.
      const base = buildCurrentLgPlacements();
      setPlacements({ [FIT_BREAKPOINT]: base.filter((p) => p.i !== type) });
      return;
    }
    const next: Record<string, Placement[]> = {};
    for (const bp of Object.keys(cur) as Breakpoint[]) {
      const arr = cur[bp];
      if (Array.isArray(arr)) next[bp] = arr.filter((p) => p.i !== type);
    }
    setPlacements(next);
  };
  const addToPlacements = (type: string) => {
    const cur = layout?.layouts;
    if (!cur) return; // nothing removed yet → already shown
    const lg = Array.isArray(cur[FIT_BREAKPOINT]) ? cur[FIT_BREAKPOINT]! : [];
    if (lg.some((p) => p.i === type)) return; // already placed
    // Drop a default-sized placement at the top-left of the lg grid; RGL's
    // vertical compaction tucks it in and the user can drag it. Other breakpoints
    // get it appended by WidgetLayout's merge against fresh defaults.
    const next: Record<string, Placement[]> = { ...(cur as Record<string, Placement[]>) };
    // Drop at the widget's registry default size so an added chart/stat/panel
    // lands at a sensible size; RGL's vertical compaction tucks it in.
    const { defaultSize } = getWidget(type);
    next[FIT_BREAKPOINT] = [
      { i: type, x: 0, y: 0, w: defaultSize.w, h: defaultSize.h, minW: defaultSize.minW, minH: defaultSize.minH },
      ...lg,
    ];
    setPlacements(next);
  };
  // The current default lg placements for the FULL available set — used to
  // materialize a saved blob the first time the user removes a widget from the
  // never-customized default. Reuses the pure engine generator so the
  // materialized blob is byte-identical to the default the grid was showing.
  const buildCurrentLgPlacements = (): Placement[] =>
    generateDefaultPlacements({ statIds: availableStats, chartIds: availableCharts, panelIds: availablePanels })[
      FIT_BREAKPOINT
    ] ?? [];

  // The palette's removable-widget groups — what the user can ADD BACK while
  // customizing. Matches the two removal signals above:
  //   • Charts: those with a spec but Phase-D visible:false (the in-app toggle /
  //     Settings hid them, or the × removed them). Offered in the user's order.
  //   • Stat cards / Panels: available (data present) but absent from the saved
  //     placements (the savedTypes gate). null savedTypes → none removed yet.
  // A plain derived value (not memoized): the inputs are rebuilt every render from
  // `layout`/`statData` anyway, so memoizing would buy nothing.
  const removedCharts = layout
    ? layout.order.filter((id) => SPEC_BY_ID[id] && !layout.widgetConfig[id]?.visible).map(chartWidgetType)
    : [];
  const paletteGroups: PaletteGroup[] = [
    { label: 'Stat cards', types: availableStats.filter((t) => !isPlaced(t)) },
    { label: 'Charts', types: removedCharts },
    { label: 'Panels', types: availablePanels.filter((t) => !isPlaced(t)) },
  ];

  // First-run convenience: kick the initial scrape once the first login verifies.
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

  // First-run setup view (unchanged).
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

        <NgLoginsSection onChanged={loadLogins} />

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
  // (overflow-hidden) and the WidgetLayout grid fills the space under the fixed
  // chrome so the PAGE never scrolls — the no-scroll PAGINATED fit (issue #73
  // iteration): view mode shows one page with a pager; customize mode scrolls the
  // grid CANVAS internally (flex-1 overflow-y-auto inside WidgetLayout) so every
  // page's widgets stay reachable while the page itself stays pinned. Both modes
  // pin at xl; below xl (and in comfortable density) the page scrolls normally.
  const lockViewport = fit;
  return (
    <div
      className={`mx-auto flex w-full max-w-[1800px] flex-col gap-3 px-3 py-3 sm:px-5 sm:py-4 ${
        lockViewport ? 'xl:h-dvh xl:gap-2 xl:overflow-hidden xl:py-3' : ''
      }`}
    >
      {/* FIXED CHROME (header, banners, range/schedule strip). Tagged so
          WidgetLayout's ResizeObserver can measure its height for the no-scroll
          fit (replacing the FILL_BODY_CLASSES constant). Everything inside here
          is layout the user can't drag; the draggable grid lives below it. */}
      <div data-dashboard-chrome className="flex shrink-0 flex-col gap-3 xl:gap-2">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
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
          {/* Header actions. flex-wrap + justify-end so the button cluster
              (Customize / bell / Tools / Settings / Refresh) wraps onto a second
              line on narrow screens instead of overflowing the viewport (the
              added Customize button pushed the unwrapped row past ~390px → a
              horizontal scrollbar on mobile). No effect at widths where they fit. */}
          <div className="flex flex-wrap items-center justify-end gap-2 gap-y-2">
            {/* Customize / Done toggle (Phase E, #73): flips the grid between the
                static default view and the drag/resize/add/remove edit mode. Only
                shown when there's data to arrange. */}
            {!empty && !layoutLoading && layout && (
              <button
                type="button"
                onClick={() => setCustomizing((v) => !v)}
                className={`btn border ${
                  customizing
                    ? 'border-amber-500/60 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30'
                    : 'border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700'
                }`}
              >
                {customizing ? (
                  <>
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                    Done
                  </>
                ) : (
                  <>
                    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 21v-4l11-11 4 4L8 21H4zM13 6l4 4" /></svg>
                    Customize
                  </>
                )}
              </button>
            )}
            {!empty && (
              <NotificationsBell
                accountId={selectedAccountId}
                bills={bills}
                onOpenCompare={() => openTools('compare')}
              />
            )}
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

        <ScrapeProgressBanner run={progressRun} onRetry={retryScrape} onDismiss={dismissProgress} />

        {reauthLogins.length > 0 && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2 text-sm text-rose-200">
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

        {/* Control strip: range picker + schedule pills. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
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

        {/* Customize-mode banner + palette: only while editing. The palette lets
            the user add back removed widgets; it sits in the chrome (above the
            grid) so it's part of the measured fixed region. */}
        {customizing && !empty && layout && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/90">
              <span>
                Customize mode — drag to move, drag a corner to resize, × to remove. Changes save automatically. Press
                <strong className="mx-1">Done</strong> when finished.
              </span>
              {/* Pinned stat strip toggle (issue #73 iteration). ON (default)
                  keeps the stat cards in a fixed band at the top, always visible;
                  OFF turns them into ordinary tiles that paginate with everything
                  else. Persists on the server layout blob. */}
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-amber-500/30 bg-slate-900/50 px-2 py-1">
                <input
                  type="checkbox"
                  checked={layout.pinnedStatStrip}
                  onChange={(e) => setPinnedStatStrip(e.target.checked)}
                  className="h-3.5 w-3.5 accent-amber-400"
                />
                <span className="text-amber-200/90">Pin stat strip</span>
              </label>
            </div>
            <WidgetPalette groups={paletteGroups} onAdd={addWidget} />
          </div>
        )}

        {/* No-budget "set a budget" affordance (issue #46). */}
        {!budget && !empty && !customizing ? (
          <div className="text-[11px] text-slate-500">
            Want to track an annual spending target?{' '}
            <Link href="/settings" className="text-amber-400 hover:underline">Set a budget</Link>.
          </div>
        ) : null}
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
      ) : layoutLoading || !layout ? (
        // SKELETON (Phase D, #96): the dashboard DEFINITION (order/config/
        // visibility + Phase-E placements) loads async; hold a neutral skeleton
        // for the grid until it resolves — never a flash of the default snapping
        // to the saved layout.
        <div className="card flex min-h-[18rem] items-center justify-center text-sm text-slate-500">
          <span className="inline-flex items-center gap-2">
            <span className="h-2 w-2 animate-pulse rounded-full bg-slate-600" />
            Loading your dashboard…
          </span>
        </div>
      ) : statIds.length + chartIds.length + panelIds.length === 0 ? (
        <div className="card text-sm text-slate-400">
          Everything is hidden. Press <span className="text-amber-400">Customize</span> to add widgets back, or enable
          charts in <Link href="/settings" className="text-amber-400">Settings</Link>.
        </div>
      ) : (
        // THE LAYOUT ENGINE (Phase E, #73): the placed widgets rendered through
        // RGL's responsive grid with the runtime no-scroll fit. Replaces the
        // hand-laid stat strip + paginated chart cockpit + bills rail.
        <WidgetLayout
          statIds={statIds}
          chartIds={chartIds}
          panelIds={panelIds}
          savedPlacements={layout.layouts}
          onPlacementsChange={setPlacements}
          fit={fit}
          customizing={customizing}
          pinnedStatStrip={layout.pinnedStatStrip}
          host={widgetHost}
          onRemoveWidget={removeWidget}
        />
      )}

      {/* On-demand Tools modal. */}
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

      {/* Footer only shows when the page can scroll. */}
      <footer className={`shrink-0 pt-1 text-center text-[11px] text-slate-600 ${lockViewport ? 'xl:hidden' : ''}`}>
        ngrid-dashboard v{process.env.NEXT_PUBLIC_APP_VERSION || 'dev'} · self-hosted · data scraped from your own
        National Grid account · not affiliated with National Grid
      </footer>
    </div>
  );
}
