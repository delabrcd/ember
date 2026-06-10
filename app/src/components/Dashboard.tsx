'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
import { HeaderActions } from './HeaderActions';
import { Wordmark } from './BrandMark';
import { BRAND } from '@/lib/brand';
import { useDashboardData } from './useDashboardData';
import { dateLabel, relativeFromNow } from '@/lib/format';
import { STAT_SPECS, type StatData } from '@/lib/widgets/statSpec';
import {
  BILLS_PANEL_TYPE,
  INTERVAL_HISTORY_WIDGET_TYPE,
  INTERVAL_WIDGET_TYPE,
  SPACER_PREFIX,
  chartWidgetType,
  getWidget,
  isSpacerId,
  statWidgetType,
  widgetMins,
  type WidgetHost,
} from '@/lib/widgets/registry';
import { WidgetLayout } from './WidgetLayout';
import { WidgetPalette, type PaletteGroup } from './WidgetPalette';
import {
  COLS,
  FIT_BREAKPOINT,
  STAT_ROWS,
  STRIP_COLS,
  findFreeSlot,
  generateDefaultPlacements,
  generateStripPlacements,
  readStrip,
  withStrip,
  type Breakpoint,
  type Placement,
} from '@/lib/layoutEngine';

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
    () => ({ ov, elecAllIn, gasAllIn, lastRow, currencyDecimals: dp, rateCardMode: prefs.rateCardMode }),
    [ov, elecAllIn, gasAllIn, lastRow, dp, prefs.rateCardMode]
  );
  // Flick the rate cards' headline between the trailing-12-mo average and the
  // current rate (compact-stat-cards iteration). Persists the choice as an ephemeral
  // per-browser display pref; the rate selectors read it off StatData and stay pure.
  const flickRateMode = useCallback(
    () => patch({ rateCardMode: prefs.rateCardMode === 'current' ? 'avg' : 'current' }),
    [patch, prefs.rateCardMode]
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
  // scroll fit: the cell height comes from RGL's computed rowHeight, and the chart
  // fills it at 100%.
  // Customize mode (Phase E). A header Customize/Done toggle; only meaningful at
  // ≥xl in fit (the grid is interactive everywhere, but the palette + the cockpit
  // shine on desktop). Off by default — the default view is the static dashboard.
  // Declared before widgetHost so the host can pass it to the spacer renderer.
  const [customizing, setCustomizing] = useState(false);

  const widgetHost: WidgetHost = {
    resolveDataset,
    specFor,
    chartFill: true,
    chartHeight: 288,
    configFor: (id) => layout?.widgetConfig[id],
    onChartChange: updateLayoutChart,
    statData,
    openTools,
    flickRateMode,
    billsData: { rangedBills, currencyDecimals: dp, csvScope, pdfScope },
    // The spacer widget reads this to switch between its dashed-outline editable form
    // and its invisible space-holding form (CHANGE 2).
    customizing,
    // The interval load-shape widget (#76) self-fetches /api/interval scoped to the
    // selected account; thread the id through the host the same way the export links
    // scope (acctQuery above).
    accountId: selectedAccountId,
    // The resolved GLOBAL range as ISO day bounds (#36): the interval widgets fetch
    // /api/interval?from=…&to=… with these so they follow the global RangeControl,
    // the same `resolved` ym bounds the monthly charts/bills/export already use
    // (widened to a full-month day span, mirroring pdfScope above).
    fromYmd: ymToYmd(resolved.fromYm),
    toYmd: ymToLastYmd(resolved.toYm),
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
  // The interval load-shape widget (#76) and the interval history widget (#121
  // part 2) are chart-category tiles that are NOT ChartSpecs (they self-fetch, no
  // `widgetConfig.visible` flag), so — like the panels — placement PRESENCE is
  // their only removed/shown signal. They lay out as normal chart tiles (2×2 grid)
  // AFTER the 7 monthly charts, in order: load-shape then history. `isPlaced`
  // (below) gates them so a brand-new user (no saved layout) gets both visible and
  // a removal sticks.
  const availableChartsAll = [...availableCharts, INTERVAL_WIDGET_TYPE, INTERVAL_HISTORY_WIDGET_TYPE];

  // SPACER instances (CHANGE 2) currently placed: read straight off the saved blob
  // (the lg page grid + the pinned strip), since spacers aren't a Phase-D-tracked
  // category — they exist only as placements. De-duped, in a stable order, so they
  // flow into WidgetLayout's placed universe and survive the merge repair.
  const spacerIds = useMemo(() => {
    const ids = new Set<string>();
    const lg = layout?.layouts?.[FIT_BREAKPOINT];
    if (Array.isArray(lg)) for (const p of lg) if (isSpacerId(p.i)) ids.add(p.i);
    const strip = readStrip(layout?.layouts ?? undefined);
    if (Array.isArray(strip)) for (const p of strip) if (isSpacerId(p.i)) ids.add(p.i);
    return [...ids];
  }, [layout]);

  // The set of widget types the SAVED layout places — the lg page grid PLUS the
  // pinned top bar (__strip). null (vs an empty set) means "no layout saved yet" →
  // show everything (today's default, acceptance #1/#4). Once saved, it's the
  // authority for STAT/PANEL membership. Including the strip ids (issue #73 polish
  // #4) is load-bearing: a widget PINNED to the bar is dropped from the lg page
  // breakpoint, so without the strip it would read as "removed" and wrongly appear
  // in the palette's add-back list while still living (highlighted) in the bar.
  const savedTypes: Set<string> | null = useMemo(() => {
    const lg = layout?.layouts?.[FIT_BREAKPOINT];
    const strip = readStrip(layout?.layouts ?? undefined);
    if (!Array.isArray(lg) && !Array.isArray(strip)) return null;
    const ids = new Set<string>();
    if (Array.isArray(lg)) for (const p of lg) ids.add(p.i);
    if (Array.isArray(strip)) for (const p of strip) ids.add(p.i);
    return ids;
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
  // The monthly charts use `availableCharts` directly (visibility owned by
  // widgetConfig). The interval widgets (#76/#121) have NO widgetConfig flag, so —
  // like the stats/panels — placement PRESENCE is their removed/shown signal: gate
  // them on `isPlaced`. This means:
  //   • a brand-new layout (savedTypes === null) → isPlaced true → both show by
  //     default, laid out cleanly by the fit paginator;
  //   • REMOVAL STICKS — removeWidget strips the tile, savedTypes loses it,
  //     isPlaced goes false, and it drops out of chartIds (no `mergePlacements`
  //     re-append, no overflowing 3rd row);
  //   • re-add from the Customize palette via the clean findFreeSlot path.
  // (Earlier this list was unconditional `availableChartsAll`, which force-appended
  // the tiles every render — breaking removal AND overflowing the fit. #121 fix.)
  const intervalWidgetTypes = [INTERVAL_WIDGET_TYPE, INTERVAL_HISTORY_WIDGET_TYPE];
  const chartIds = [...availableCharts, ...intervalWidgetTypes.filter(isPlaced)];
  const panelIds = availablePanels.filter(isPlaced);

  // The dashboard is ALWAYS the paginated fit layout now (the old 'comfortable'
  // density was retired when Customize mode + the fit pager superseded it). At ≥xl
  // this pins the page to the viewport and paginates; below xl it scrolls as before.
  const fit = true;

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
    const next: Record<string, Placement[]> = { ...(cur as Record<string, Placement[]>) };
    // Drop at the widget's registry default size on the FIRST free slot of the lg
    // grid. Under DISPLACEMENT+COMPACTION (CHANGE 2) RGL would otherwise drop a new
    // tile at (0,0) and shove the existing tiles down; landing it on an empty patch
    // (findFreeSlot scans reading-order for the first non-overlapping cell, always
    // finding one below the layout at worst) keeps the add tidy, and vertical
    // compaction then packs it into place. Other breakpoints get it appended by
    // WidgetLayout's merge against fresh defaults.
    const { defaultSize } = getWidget(type);
    const slot = findFreeSlot(lg, defaultSize, COLS[FIT_BREAKPOINT]);
    next[FIT_BREAKPOINT] = [
      { i: type, x: slot.x, y: slot.y, w: defaultSize.w, h: defaultSize.h, minW: defaultSize.minW, minH: defaultSize.minH },
      ...lg,
    ];
    setPlacements(next);
  };

  // Add a NEW spacer instance (CHANGE 2). Spacers are multi-instance (`spacer:1`,
  // `spacer:2`, …) and always addable, so this mints a FRESH id (one past the
  // highest existing spacer number) and drops it at a free lg slot. If no layout is
  // saved yet, we first materialize the current default (so the new spacer sticks as
  // an explicit placement). It persists as a normal placement and survives reload.
  const addSpacer = () => {
    // The next free spacer number: max existing + 1 (1-based), so removing then
    // re-adding doesn't collide with a surviving instance.
    const nums = spacerIds.map((id) => Number(id.slice(SPACER_PREFIX.length + 1))).filter((n) => Number.isFinite(n));
    const nextId = `${SPACER_PREFIX}:${(nums.length ? Math.max(...nums) : 0) + 1}`;
    const { defaultSize } = getWidget(nextId);
    const lg = Array.isArray(layout?.layouts?.[FIT_BREAKPOINT])
      ? layout!.layouts![FIT_BREAKPOINT]!
      : buildCurrentLgPlacements();
    const slot = findFreeSlot(lg, defaultSize, COLS[FIT_BREAKPOINT]);
    const newTile: Placement = {
      i: nextId,
      x: slot.x,
      y: slot.y,
      w: defaultSize.w,
      h: defaultSize.h,
      minW: defaultSize.minW,
      minH: defaultSize.minH,
    };
    // Preserve any other saved breakpoints + the strip; only the lg page grid gains
    // the new spacer (other breakpoints pick it up via WidgetLayout's merge defaults).
    const cur = layout?.layouts;
    const next: Record<string, Placement[]> = cur ? { ...(cur as Record<string, Placement[]>) } : {};
    next[FIT_BREAKPOINT] = [newTile, ...lg];
    const strip = readStrip(cur ?? undefined);
    setPlacements(strip ? withStrip(next as Record<Breakpoint, Placement[]>, strip) : next);
  };
  // The current default lg placements for the FULL available set — used to
  // materialize a saved blob the first time the user removes a widget from the
  // never-customized default. Reuses the pure engine generator so the
  // materialized blob is byte-identical to the default the grid was showing.
  const buildCurrentLgPlacements = (): Placement[] =>
    generateDefaultPlacements({
      statIds: availableStats,
      chartIds: availableChartsAll,
      panelIds: availablePanels,
      mins: widgetMins([...availableStats, ...availableChartsAll, ...availablePanels]),
    })[FIT_BREAKPOINT] ?? [];

  // ---- Pin / unpin a widget to the top bar (issue #73 polish #4) ----
  // The operator wants ANY widget (chart/panel/stat) movable to the top bar and
  // back — indicated by a highlight. The bar is the existing __strip RGL grid; this
  // is the robust per-widget TOGGLE (literal cross-grid drag is fragile). It edits
  // the SAME layout blob (no schema change): pinning adds the widget's placement to
  // __strip (at a free strip slot) and DROPS it from every page breakpoint; unpin
  // removes it from __strip and re-adds it to a free page slot at each breakpoint.
  // WidgetLayout excludes pinned ids from the paged grid, so the visible move is
  // immediate and survives a reload. Idempotent + structural (setPlacements →
  // debounced PUT; placementsEqual guards the re-feed loop), so no React #185.
  const togglePin = (type: string) => {
    // The effective current strip: the saved __strip if present, else today's
    // default stat band (the pre-customization strip). Materializing it here means
    // pinning the FIRST non-stat widget keeps the existing stat pins instead of
    // wiping them (the migration default becomes explicit on first edit).
    const cur = layout?.layouts;
    const curStrip = readStrip(cur ?? undefined) ?? generateStripPlacements(statIds, widgetMins(statIds));
    // The page breakpoints: the saved blob if present, else the freshly generated
    // default for the full available set (so a never-customized layout still gets a
    // complete set of page placements to move the widget between).
    const fullDefault = generateDefaultPlacements({
      statIds: availableStats,
      chartIds: availableChartsAll,
      panelIds: availablePanels,
      mins: widgetMins([...availableStats, ...availableChartsAll, ...availablePanels]),
    });
    const pageBlob: Record<string, Placement[]> = {};
    for (const bp of Object.keys(COLS) as Breakpoint[]) {
      const saved = cur?.[bp];
      pageBlob[bp] = Array.isArray(saved) ? [...saved] : (fullDefault[bp] ?? []);
    }

    const isPinned = curStrip.some((p) => p.i === type);
    let nextStrip: Placement[];
    if (isPinned) {
      // UNPIN: drop from the strip, then ensure it has a page placement to return
      // to at every breakpoint (a free slot if it's missing there).
      nextStrip = curStrip.filter((p) => p.i !== type);
      const { defaultSize } = getWidget(type);
      for (const bp of Object.keys(COLS) as Breakpoint[]) {
        const arr = pageBlob[bp]!;
        if (arr.some((p) => p.i === type)) continue; // already has a page slot
        const slot = findFreeSlot(arr, defaultSize, COLS[bp]);
        arr.unshift({
          i: type,
          x: slot.x,
          y: slot.y,
          w: Math.min(defaultSize.w, COLS[bp]),
          h: defaultSize.h,
          minW: defaultSize.minW,
          minH: defaultSize.minH,
        });
      }
    } else {
      // PIN: add to the strip at a free slot (a COMPACT strip size so a pinned
      // chart/panel doesn't make the bar viewport-tall — the strip is a thin band).
      // Then drop the widget from every page breakpoint so it lives ONLY in the bar.
      const { defaultSize } = getWidget(type);
      const stripSize = stripSizeFor(type, defaultSize);
      const slot = findFreeSlot(curStrip, stripSize, STRIP_COLS);
      nextStrip = [
        ...curStrip,
        {
          i: type,
          x: slot.x,
          y: slot.y,
          w: stripSize.w,
          h: stripSize.h,
          minW: defaultSize.minW,
          minH: defaultSize.minH,
        },
      ];
      for (const bp of Object.keys(COLS) as Breakpoint[]) {
        pageBlob[bp] = pageBlob[bp]!.filter((p) => p.i !== type);
      }
    }

    setPlacements(withStrip(pageBlob as Record<Breakpoint, Placement[]>, nextStrip));
  };

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
  // The interval load-shape (#76) and interval history (#121 part 2) widgets are
  // chart tiles gated on placement presence (no widgetConfig flag), so they join
  // the Charts palette group when they've been removed (not currently placed).
  const removedIntervalWidget = !isPlaced(INTERVAL_WIDGET_TYPE) ? [INTERVAL_WIDGET_TYPE] : [];
  const removedIntervalHistory = !isPlaced(INTERVAL_HISTORY_WIDGET_TYPE) ? [INTERVAL_HISTORY_WIDGET_TYPE] : [];
  const paletteGroups: PaletteGroup[] = [
    { label: 'Stat cards', types: availableStats.filter((t) => !isPlaced(t)) },
    { label: 'Charts', types: [...removedCharts, ...removedIntervalWidget, ...removedIntervalHistory] },
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
            <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-slate-50">
              <span>Welcome to</span>
              <Wordmark textClassName="text-2xl" />
            </h1>
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
  // pin at xl; below xl the page scrolls normally.
  const lockViewport = fit;
  return (
    // FULL-WIDTH SHELL (issue #73 polish — operator: "left/right banding bars on
    // hi-dpi / zoomed-out screens"). The shell used to cap at `max-w-[1800px]
    // mx-auto`, so on a very wide / zoomed-out / hi-DPI-CSS-px viewport the content
    // sat in a centered column with empty side BANDS. We drop the cap so the layout
    // fills the FULL viewport width at any width (RGL's WidthProvider then measures
    // the full content width and the grid spans it edge-to-edge), keeping only the
    // small side padding (`px-3` / `sm:px-5`) as a gutter. No mx-auto/max-w now.
    //
    // BOTTOM PADDING (issue #73 polish — operator: "no padding at the bottom"). In
    // the pinned fit view the pager sat flush against the viewport bottom. We add a
    // bottom gutter matching the top (`xl:pb-3`) AND reserve it in the fit math (see
    // BOTTOM_PAD in WidgetLayout, subtracted from availH) so the gutter doesn't
    // reintroduce a scroll or clip the pager — it just opens a visible gap below it.
    <div
      className={`flex w-full flex-col gap-3 px-3 py-3 sm:px-5 sm:py-4 ${
        lockViewport ? 'xl:h-dvh xl:gap-2 xl:overflow-hidden xl:py-3' : ''
      }`}
    >
      {/* FIXED CHROME (header, banners, range/schedule strip). Tagged so
          WidgetLayout's ResizeObserver can measure its height for the no-scroll
          fit (the grid rowHeight is derived from it). Everything inside here
          is layout the user can't drag; the draggable grid lives below it. */}
      <div data-dashboard-chrome className="flex shrink-0 flex-col gap-3 xl:gap-2">
        {/* HARD TOP-RIGHT ACTIONS (issue #73 mobile fix): a NO-WRAP row with the
            title/account block on the left and the action area on the right. The
            title block is `min-w-0` so it can SHRINK and truncate; the action area
            is `shrink-0` and anchored right via `justify-between`, so the hamburger
            (mobile) / inline buttons (≥sm) can NEVER wrap to a new line or drift
            left — other content yields to it. */}
        <header className="flex flex-nowrap items-center justify-between gap-x-3">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="min-w-0 truncate text-lg sm:text-xl">
                <Wordmark className="align-baseline" />
              </h1>
              <span className="hidden shrink-0 rounded-full border border-slate-700/70 bg-slate-800/50 px-2 py-0.5 font-mono text-xs text-slate-400 sm:inline">
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
                <p className="hidden min-w-0 truncate text-sm text-slate-400 sm:block">
                  Account {ov.account.accountNumber}
                  {ov.account.serviceAddress ? ` · ${ov.account.serviceAddress}` : ''}
                  {ov.account.companyCode ? ` · ${ov.account.companyCode}` : ''}
                </p>
              )
            )}
          </div>
          {/* Header actions (Customize / bell / Tools / Settings / Refresh). At
              ≥sm they render inline exactly as before; below sm they collapse into
              a ☰ hamburger menu (the bell stays visible) so they never overflow a
              phone — HeaderActions owns that responsive split and shares every
              handler between the inline buttons and the menu items (issue #73). */}
          <HeaderActions
            empty={empty}
            canCustomize={!empty && !layoutLoading && !!layout}
            customizing={customizing}
            onToggleCustomize={() => setCustomizing((v) => !v)}
            onOpenTools={() => openTools('compare')}
            accountId={selectedAccountId}
            bills={bills}
            rows={rows}
            onRefreshDone={load}
            onRefreshStarted={trackRun}
            scraping={scraping}
          />
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

        {/* Control strip: range picker + schedule pills. On a phone these must
            stay TIDY (issue #73): the range presets keep their own segmented row,
            and the schedule pills flow as a compact WRAPPING row (never one-per-
            line). The strip wraps as a whole at narrow widths so the schedule
            group drops below the range group rather than overflowing sideways, and
            each pill is `whitespace-nowrap` so a pill stays intact while the ROW
            (not the pill) wraps. The "Next bill" relative-time parenthetical is
            hidden below sm so the pill stays short on a phone. */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {!empty && (
            <RangeControl range={prefs.range} onChange={setRange} allYms={allYms} nowYm={nowYm} />
          )}
          {ov?.schedule && (
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <span className="pill whitespace-nowrap">
                Next bill <strong className="text-slate-100">{dateLabel(ov.schedule.predictedNextBillDate)}</strong>
                {ov.schedule.predictedNextBillDate ? (
                  <span className="hidden sm:inline"> ({relativeFromNow(ov.schedule.predictedNextBillDate + 'T00:00:00')})</span>
                ) : null}
              </span>
              <span className="pill whitespace-nowrap">Checked {relativeFromNow(ov.schedule.lastCheckedAt)}</span>
              <span className="pill whitespace-nowrap">Next {relativeFromNow(ov.schedule.nextCheckAt)}</span>
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
                Customize mode — drag to move, drag a corner to resize, the pin to add/remove a widget from the top bar,
                × to remove. Changes save automatically. Press
                <strong className="mx-1">Done</strong> when finished.
              </span>
              {/* Top-bar toggle (issue #73 polish #4 — generalized from stats-only).
                  ON (default) shows the pinned top bar (always visible, not paged);
                  OFF hides the bar and its widgets fall back onto the scrollable
                  pages. The bar can now hold ANY pinned widget (chart/panel/stat),
                  not just stats. Persists on the server layout blob. */}
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-amber-500/30 bg-slate-900/50 px-2 py-1">
                <input
                  type="checkbox"
                  checked={layout.pinnedStatStrip}
                  onChange={(e) => setPinnedStatStrip(e.target.checked)}
                  className="h-3.5 w-3.5 accent-amber-400"
                />
                <span className="text-amber-200/90">Show top bar</span>
              </label>
            </div>
            <WidgetPalette groups={paletteGroups} onAdd={addWidget} onAddSpacer={addSpacer} />
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
          onTogglePin={togglePin}
          spacerIds={spacerIds}
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
        {BRAND.name} v{process.env.NEXT_PUBLIC_APP_VERSION || 'dev'} · self-hosted · data scraped from your own
        National Grid account · not affiliated with National Grid
      </footer>
    </div>
  );
}

// The size a widget gets when PINNED to the top bar (issue #73 polish #4). The bar
// is a thin band (STRIP_ROW_HEIGHT ≈ 28px/row, content-sized — not viewport-tall),
// so a stat keeps its compact band geometry (STAT_ROWS rows ≈ the strip card),
// while a CHART or PANEL — whose page default is tall (h=7/14) — is clamped to a
// compact bar tile so pinning one doesn't make the bar swallow the viewport. The
// user can still drag-resize it within the bar afterward. Uses STAT_ROWS from the
// layout engine so the pinned height tracks the compact strip-card height.
function stripSizeFor(type: string, defaultSize: { w: number; h: number }): { w: number; h: number } {
  if (type.startsWith('stat:')) return { w: defaultSize.w, h: STAT_ROWS };
  // Charts / panels: a quarter-width, compact STAT_ROWS-tall bar tile by default.
  return { w: 3, h: STAT_ROWS };
}
