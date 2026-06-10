// Unified widget registry (Phase A of the UI re-architecture, issue #93; RFC
// §3.1). A widget is the atomic, placeable unit: a declarative descriptor + a
// render fn. Phase A keeps it MINIMAL — just enough to render BOTH the existing
// 7 charts and the 8 stat cards through one registry, in the current layout,
// with zero visual change. The layout engine, drag/resize, per-widget config
// schema and persistence are deliberately NOT here (later phases).
//
// Two categories are wired in Phase A:
//   • 'chart' — wraps the existing ChartSpec + ConfigurableChart UNCHANGED (we
//     keep the good declarative chart layer). The widget's render is fed a
//     host-provided adapter so the issue #71 spec-stripping and #52/#71 forward-
//     projection row append still produce byte-identical specs/rows — that logic
//     stays in Dashboard.tsx and is passed in, not duplicated here.
//   • 'stat' — renders a declarative StatSpec (lib/widgets/statSpec.ts) via the
//     shared StatCard renderer or, for the two bespoke cards, their dedicated
//     render fns. All number/selector logic is the pure StatSpec; the registry
//     only routes a spec to its renderer.
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW TO ADD A NEW WIDGET (read this before adding one)
// ─────────────────────────────────────────────────────────────────────────────
// There are two kinds of widget you might add, and they differ in how visibility
// is tracked. Pick the right path or the dashboard layout WILL break (see the
// cautionary tale at the end).
//
// A) A SELF-CONTAINED widget (own data fetch + Recharts), e.g. IntervalLoadShape /
//    IntervalHistory. This is the simplest path and does NOT touch the ChartSpec /
//    ConfigurableChart / vizType seam.
//    1. Build the component in `app/src/components/widgets/<Name>.tsx` ('use client').
//       Read account scope from `host.accountId`; handle loading / EMPTY / populated
//       states (an empty widget reads as broken). Keep number/parse logic in a PURE,
//       unit-tested lib (e.g. lib/intervalProfile.ts) — not in the component.
//    2. Register it below: export a `type` const, add a `WidgetDef`
//       ({ type, category:'chart', dataDeps:[], render: (host) => <Name … />,
//       defaultSize:{w,h,minW,minH} }), and put it in the `WIDGETS` map. Update the
//       registry-count assertion in `app/test/widgets.test.ts`.
//    3. Make it default-visible + REMOVABLE in `app/src/components/Dashboard.tsx`:
//       add its type to `availableChartsAll` AND to `intervalWidgetTypes` (the
//       `chartIds = [...availableCharts, ...intervalWidgetTypes.filter(isPlaced)]`
//       line), and add a `removed…` entry to the Customize palette list so it can be
//       re-added. `isPlaced` gives you: shown by default on a fresh layout, removal
//       that STICKS, and re-add via the clean findFreeSlot path.
//
// B) A declarative TIMESERIES chart over the monthly series: add a `ChartSpec` to
//    `lib/chartSpec.ts` (`CHART_SPECS`) + its config to `lib/chartConfig.ts`
//    (DEFAULT_CHART_ORDER/CONFIG). Visibility is owned by `widgetConfig.visible`
//    (Settings + the in-chart toggle); `availableCharts` already filters on it. No
//    Dashboard wiring beyond the spec. (Non-timeseries vizTypes — profile/heatmap/
//    scatter — need the #95 Phase C renderer; don't shoehorn them through here.)
//
// ⚠ CAUTION (the #121 bug): do NOT put a non-spec widget UNCONDITIONALLY into
// `chartIds` (e.g. `chartIds = availableChartsAll`). That force-appends it every
// render via mergePlacements, so (a) the user can't remove it — it re-appears — and
// (b) the forced append lands it in an overflowing extra row that pushes a chart
// and the pager off-screen in the fit cockpit. ALWAYS gate a non-spec widget on
// `isPlaced` (path A.3). A fresh layout still shows it (savedTypes === null →
// isPlaced true); the clean paginator lays it out without overflow.

import type { ReactNode } from 'react';
import { CHART_SPECS, type ChartSpec } from '@/lib/chartSpec';
import type { DatasetId, DatasetResolver } from '@/lib/datasets';
import { getVizRenderer } from '@/lib/widgets/vizRenderers';
import { STAT_SPECS, type StatData, type StatSpec } from '@/lib/widgets/statSpec';
import { BudgetStatCard, StatCard, YoyStatCard } from '@/components/widgets/StatCard';
import { BillsPanel, type BillsPanelData } from '@/components/widgets/BillsPanel';
import { IntervalHistory } from '@/components/widgets/IntervalHistory';
import { IntervalLoadShape } from '@/components/widgets/IntervalLoadShape';
import { Spacer } from '@/components/widgets/Spacer';
import type { ChartConfig } from '@/lib/prefs';
import type { ToolsTab } from '@/components/ToolsModal';
import { essentialHeightPx, pxToMinRows, type StatCardKind } from '@/lib/widgets/cardFit';
import { STAT_ROWS } from '@/lib/layoutEngine';

// Reference rowHeight (px) + RGL margin used ONLY to translate a widget's
// essential CONTENT height (from cardFit.ts) into a grid-row `minH`. Stat cards'
// DEFAULT home is the pinned strip, which renders at the fixed STRIP_ROW_HEIGHT
// (30px) — so we derive `minH` against that row height, the height the card
// actually occupies where it lives by default. At 30px EVERY card (border + padding
// + title + headline = 66px) needs minH=2 — including the budget card, whose ~6px
// progress bar now fits WITHIN that shared height (visual-uniformity pass) rather
// than reserving its own extra row, so all strip cards are one uniform height — the
// compact single-row strip (the compact-stat-cards iteration: brief title +
// headline only, detail moved to the ⓘ
// tooltip). `overflow-hidden` on the card is the hard backstop if a tile is ever
// dragged shorter (e.g. onto the paged grid, whose fit row can bottom out at 24px).
// Mirrors MARGIN/STRIP_ROW_HEIGHT in WidgetLayout.
const REF_ROW_HEIGHT = 30; // = STRIP_ROW_HEIGHT (the stat cards' default home)
const REF_MARGIN = 8;

// The grid `minH` for a stat card of the given kind: the row count whose pixels
// cover the card's ESSENTIAL content (title + headline, + the budget bar). The
// detail/sub line is NOT in the essential block — it hides via the container
// query when it wouldn't fit — so minH guarantees only the must-show content,
// and a card resized to minH never overflows. Derived, not hand-guessed.
function statMinH(kind: StatCardKind): number {
  return pxToMinRows(essentialHeightPx(kind), REF_ROW_HEIGHT, REF_MARGIN);
}

// The host context every widget render can read.
//   • chart widgets (Phase B, #94): they declare a `dataset` dependency and the
//     host RESOLVES it → rows (`resolveDataset`). For `'monthly'` the resolver
//     returns the SAME projection-aware `MonthRow[]` Dashboard.chartRows() built,
//     so the #71 spec-stripping + #52/#71 forward-projection append stay in one
//     place and the output is byte-identical. The spec the renderer draws still
//     comes from `specFor` (it carries the #71 proj*-series stripping), plus the
//     fill/height layout knobs Dashboard already passed ConfigurableChart.
//   • stat widgets: the StatData bag + the openTools callback for the two
//     clickable cards (unchanged from Phase A; routing stats through the dataset
//     layer is a later, opt-in change — see datasets.ts).
export interface WidgetHost {
  // Dataset resolution (Phase B) — given a DatasetId + the widget id, returns
  // that dataset's rows. The chart widget consumes its declared `spec.dataset`
  // through this, never assuming `MonthRow` directly.
  resolveDataset: DatasetResolver;
  // The (possibly projection-stripped) spec to draw — IDENTICAL to
  // Dashboard.tsx's specFor(); kept so the #71 stripping stays in one place and
  // the rendered output is unchanged.
  specFor: (id: string) => ChartSpec;
  chartFill: boolean;
  chartHeight: number;
  // Per-chart config + its write-back (Phase D, #96). The dashboard now sources a
  // chart's config (hidden series / type / stacked / scales / visibility) from
  // the SERVER layout (useDashboardLayout) rather than letting ConfigurableChart
  // read it from localStorage prefs. The host hands the chart its config and an
  // onChange that PUTs the edit back, so the in-chart "Customize" popover persists
  // to the server. Optional so non-dashboard callers (the demo gallery) can omit
  // them and ConfigurableChart falls back to its prefs-backed config, unchanged.
  configFor?: (id: string) => ChartConfig | undefined;
  onChartChange?: (id: string, c: Partial<ChartConfig>) => void;
  // Stat inputs.
  statData: StatData;
  openTools: (tab: ToolsTab) => void;
  // Toggle the rate cards' headline mode (12-mo avg ↔ current) — the flick
  // interaction (compact-stat-cards iteration). The rate stat cards render a
  // clickable affordance wired to this; it persists the choice via the display
  // prefs (rateCardMode). Optional so a non-dashboard caller (the demo gallery) can
  // omit it and the rate cards render static.
  flickRateMode?: () => void;
  // Panel inputs (Phase E, #73): the bills rail is now a placeable `panel`
  // widget, fed the SAME range-filtered bills + export-scope query fragments the
  // inline rail read in Dashboard.tsx, so it renders byte-identically.
  billsData: BillsPanelData;
  // Whether the dashboard is in Customize mode (CHANGE 2). The SPACER widget reads
  // this to switch between its dashed-outline editable form (customizing) and its
  // invisible space-holding form (view). Optional so a non-dashboard caller can omit
  // it (spacers then render invisible). A single dashboard-level flag — the same
  // value WidgetCell passes its cells — so it's correct for every cell.
  customizing?: boolean;
  // The SELECTED account id (issue #76). The interval load-shape widget self-fetches
  // /api/interval and scopes the request to this account, the same id the export
  // links and other read routes use. Optional so a non-dashboard caller (the demo
  // gallery) can omit it (the widget then fetches the default account).
  accountId?: number | null;
}

// WidgetDef (RFC §3.1). `defaultSize` is now REAL (Phase E, #73): the grid size
// the widget palette uses when ADDING the widget back to the lg grid, in 12-col
// units + grid rows, with sensible min bounds so a widget can't be resized into
// uselessness. (The default DASHBOARD arrangement comes from the layoutEngine
// generator, not these per-widget sizes — `defaultSize` is the add-one-widget
// fallback.)
export interface WidgetDef {
  type: string; // registry key
  category: 'chart' | 'stat' | 'tool' | 'panel';
  title: string;
  // The datasets this widget consumes (RFC §3.1 `dataDeps`). The host provides
  // these — a chart-widget declares `[spec.dataset]` and pulls its rows from the
  // resolver. Stat widgets read the `ov` bag off the host directly in Phase A,
  // so they declare none yet (`[]`).
  dataDeps: DatasetId[];
  defaultSize: { w: number; h: number; minW: number; minH: number };
  render: (host: WidgetHost) => ReactNode;
}

// Build a chart-widget for one ChartSpec. The render now (Phase B, #94):
//   1. declares `dataDeps: [spec.dataset]` so the layer knows what data it needs,
//   2. RESOLVES that dataset through the host (for `'monthly'` → the same
//      projection-appended `MonthRow[]` Dashboard.chartRows() produced), and
//   3. dispatches on `spec.vizType` to the matching renderer (only `'timeseries'`
//      exists — the existing ConfigurableChart).
// The (possibly projection-stripped) spec still comes from `host.specFor`, so the
// #71/#52 logic is unchanged and the output is byte-identical. `key`/wrapper div
// stay the caller's concern, matching the old `.map((id) => <div key={id}>…)`.
function chartWidget(spec: ChartSpec): WidgetDef {
  return {
    type: `chart:${spec.id}`,
    category: 'chart',
    title: spec.title,
    dataDeps: [spec.dataset],
    // A chart is HALF the lg grid (6 of 12 cols) and tall (7 rows = CHART_ROWS);
    // mirrors the default generator's 2×2 two-up chart placement (issue #73
    // density iteration). minW=3 keeps an added chart at least quarter-width.
    defaultSize: { w: 6, h: 7, minW: 3, minH: 3 },
    render: (host) => {
      const drawn = host.specFor(spec.id);
      const rows = host.resolveDataset(drawn.dataset, spec.id);
      return getVizRenderer(drawn.vizType)({
        spec: drawn,
        rows,
        fill: host.chartFill,
        height: host.chartHeight,
        // Phase D (#96): when the host supplies a server-backed config + write-back
        // for this chart, thread them to the renderer so the chart reads/writes the
        // SERVER layout instead of localStorage. Omitted → ConfigurableChart keeps
        // its prefs-backed behavior (the demo gallery path).
        config: host.configFor?.(spec.id),
        onConfigChange: host.onChartChange ? (c) => host.onChartChange!(spec.id, c) : undefined,
      });
    },
  };
}

// Build a stat-widget for one StatSpec. Routes to the matching renderer by kind;
// the spec's pure selector produces the model the renderer lays out. isVisible is
// the host's concern (it filters before rendering, as the old JSX guards did), so
// render assumes the card should show.
function statWidget(spec: StatSpec): WidgetDef {
  return {
    type: `stat:${spec.id}`,
    category: 'stat',
    title: spec.id,
    // Stat widgets read the `ov` bag off the host directly (Phase A); routing
    // them through the dataset layer is a later, opt-in change. No deps yet.
    dataDeps: [],
    // A COMPACT KPI card (compact-stat-cards iteration). The card body is now just
    // the (brief) title + the headline value (+ the budget bar) — the sub/detail
    // line moved into the ⓘ tooltip — so the card is short and narrow. minW=1 lets
    // all 8 stat cards lay out in a SINGLE row of the 12-col strip (the operator's
    // ask: one row, not two). minH is DERIVED from the card's essential content
    // (cardFit.ts) at the strip's row height — every card (budget included) → 2 rows
    // now, one uniform strip-card height (the budget bar fits within it, no extra
    // row). `defaultSize.w`/`h` are the add-one-widget fallback; the default strip
    // widths come from the layout generator.
    defaultSize: {
      w: 2,
      h: STAT_ROWS,
      minW: 1,
      minH: statMinH(spec.kind === 'budget' ? 'budget' : 'simple'),
    },
    render: (host) => {
      const d = host.statData;
      if (spec.kind === 'simple') {
        const model = spec.select(d);
        // Only the rate cards emit a `flick` affordance; wiring host.flickRateMode as
        // its onFlick makes the card clickable + keyboard-activatable. A simple card
        // without `flick` renders static (no onFlick → not clickable).
        return <StatCard model={model} onFlick={model.flick ? host.flickRateMode : undefined} />;
      }
      if (spec.kind === 'yoy') return <YoyStatCard model={spec.select(d)} openTools={host.openTools} />;
      return <BudgetStatCard model={spec.select(d)} openTools={host.openTools} />;
    },
  };
}

// The bills rail as a `panel` widget (Phase E, #73). One instance, id
// 'panel:bills'. Renders the BillsPanel from the host's range-filtered bills +
// export scopes. It's full-width (12 of 12 cols at lg) and one page-band tall so
// it occupies its own page below the 2×2 charts (issue #73 density iteration);
// it scrolls internally so a full page of bills reads well.
const BILLS_PANEL: WidgetDef = {
  type: 'panel:bills',
  category: 'panel',
  title: 'Bills',
  dataDeps: ['bills'],
  defaultSize: { w: 12, h: 14, minW: 3, minH: 4 },
  render: (host) => <BillsPanel data={host.billsData} />,
};

// The interval LOAD-SHAPE widget (issue #76). A SELF-CONTAINED chart tile: it
// fetches its own data from /api/interval (scoped to host.accountId) and shapes it
// with the PURE averageDayProfile, so it does NOT declare a dataset dep or go
// through resolveDataset — `dataDeps: []`. Categorized 'chart' so it lays out as a
// normal half-width chart tile (the default generator's 2×2), sized like the other
// charts. Placed on the dashboard as a default-visible tile after the existing 7.
export const INTERVAL_WIDGET_TYPE = 'interval-load-shape' as const;
const INTERVAL_WIDGET: WidgetDef = {
  type: INTERVAL_WIDGET_TYPE,
  category: 'chart',
  title: 'Average daily load shape',
  dataDeps: [],
  // Same footprint as a chart widget (half the lg grid, tall) so it tiles in the
  // 2×2 chart grid alongside the monthly charts.
  defaultSize: { w: 6, h: 7, minW: 3, minH: 3 },
  render: (host) => <IntervalLoadShape accountId={host.accountId} />,
};

// The interval HISTORY widget (issue #121 part 2). A SELF-CONTAINED chart tile
// showing the RAW historical timeline of smart-meter reads. Like the load-shape
// widget it self-fetches /api/interval (scoped to host.accountId) and does NOT
// go through resolveDataset — `dataDeps: []`. Categorized 'chart' so it lays
// out as a normal half-width chart tile (the default generator's 2×2), sized
// like the other charts. Placed on the dashboard as a default-visible tile
// after the load-shape widget.
export const INTERVAL_HISTORY_WIDGET_TYPE = 'interval-history' as const;
const INTERVAL_HISTORY_WIDGET: WidgetDef = {
  type: INTERVAL_HISTORY_WIDGET_TYPE,
  category: 'chart',
  title: 'Usage history',
  dataDeps: [],
  // Same footprint as the other chart widgets (half the lg grid, tall) so it
  // tiles in the 2×2 chart grid alongside the monthly charts and the load-shape.
  defaultSize: { w: 6, h: 7, minW: 3, minH: 3 },
  render: (host) => <IntervalHistory accountId={host.accountId} />,
};

// The SPACER widget (CHANGE 2, issue #73). Unlike every other widget type — which
// is a SINGLETON keyed by a fixed id — the spacer is MULTI-INSTANCE: the user can
// add as many as they like, keyed `spacer:1`, `spacer:2`, … . The registry stores
// ONE prototype def under the bare `spacer` key; getWidget resolves any concrete
// `spacer:<n>` id to it (its render/defaultSize/title don't depend on the instance
// number). A spacer holds its grid cell like a panel but renders invisibly in view
// mode (it reads host.customizing). Default 2×2 with minW=1/minH=1 (the brief's
// "1×2, minW 1, minH 1" floor — a 2-wide default reads better in the 12-col grid)
// so it respects the min-size guarantee and can be dragged small.
export const SPACER_PREFIX = 'spacer' as const;
const SPACER_WIDGET: WidgetDef = {
  type: SPACER_PREFIX,
  category: 'tool',
  title: 'Spacer',
  dataDeps: [],
  defaultSize: { w: 2, h: 2, minW: 1, minH: 1 },
  render: (host) => <Spacer customizing={!!host.customizing} />,
};

// Is a concrete id a spacer instance (`spacer:1`, `spacer:2`, …)? The colon + a
// non-empty suffix distinguishes it from the bare prototype key.
export function isSpacerId(type: string): boolean {
  return type.startsWith(`${SPACER_PREFIX}:`) && type.length > SPACER_PREFIX.length + 1;
}

// The registry: every chart id, every stat id, plus the bills panel and the spacer
// PROTOTYPE — keyed by widget type. The `chart:`/`stat:`/`panel:` prefixes keep the
// namespaces distinct in one record (RFC §3.1's `type` examples, e.g. 'tool:compare').
// The spacer is stored under its bare prefix (`spacer`); concrete `spacer:<n>`
// instances resolve to it in getWidget (the multi-instance exception).
export const WIDGETS: Record<string, WidgetDef> = Object.fromEntries([
  ...CHART_SPECS.map((s) => [`chart:${s.id}`, chartWidget(s)] as const),
  ...STAT_SPECS.map((s) => [`stat:${s.id}`, statWidget(s)] as const),
  [BILLS_PANEL.type, BILLS_PANEL] as const,
  [INTERVAL_WIDGET.type, INTERVAL_WIDGET] as const,
  [INTERVAL_HISTORY_WIDGET.type, INTERVAL_HISTORY_WIDGET] as const,
  [SPACER_PREFIX, SPACER_WIDGET] as const,
]);

// Type-keyed accessors so callers don't hand-build the prefixed string. A
// missing key throws — a chart/stat that isn't registered is a bug, not a
// silent no-render (the registry-completeness test guards this).
export const chartWidgetType = (id: string) => `chart:${id}`;
export const statWidgetType = (id: string) => `stat:${id}`;
// The single bills panel's widget type — exported so the dashboard's default
// placement input and the palette can reference it without string-building.
export const BILLS_PANEL_TYPE = BILLS_PANEL.type;

export function getWidget(type: string): WidgetDef {
  // Multi-instance spacers (CHANGE 2): any `spacer:<n>` resolves to the single
  // spacer prototype (its render/size/title are instance-independent). Every other
  // type is a singleton looked up directly.
  const key = isSpacerId(type) ? SPACER_PREFIX : type;
  const w = WIDGETS[key];
  if (!w) throw new Error(`Unknown widget type: ${type}`);
  return w;
}

// The per-widget min grid bounds (minW/minH from each widget's `defaultSize`) for
// the given ids, keyed by widget type. Threaded into the pure layout generator
// (`generateDefaultPlacements`/`generateStripPlacements`) so it can guarantee no
// default placement falls below a widget's min — without importing the registry
// into the pure engine (issue #73 fix: the crushed-stat-card default). Unknown ids
// are skipped (the generator defaults their floor to 1).
export function widgetMins(ids: string[]): Record<string, { minW: number; minH: number }> {
  const out: Record<string, { minW: number; minH: number }> = {};
  for (const id of ids) {
    // Resolve multi-instance spacers (`spacer:<n>`) to their prototype so a placed
    // spacer carries its min floor too (CHANGE 2).
    const w = WIDGETS[isSpacerId(id) ? SPACER_PREFIX : id];
    if (w) out[id] = { minW: w.defaultSize.minW, minH: w.defaultSize.minH };
  }
  return out;
}
