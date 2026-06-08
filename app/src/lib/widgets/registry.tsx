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

import type { ReactNode } from 'react';
import { CHART_SPECS, type ChartSpec } from '@/lib/chartSpec';
import type { DatasetId, DatasetResolver } from '@/lib/datasets';
import { getVizRenderer } from '@/lib/widgets/vizRenderers';
import { STAT_SPECS, type StatData, type StatSpec } from '@/lib/widgets/statSpec';
import { BudgetStatCard, StatCard, YoyStatCard } from '@/components/widgets/StatCard';
import { BillsPanel, type BillsPanelData } from '@/components/widgets/BillsPanel';
import type { ChartConfig } from '@/lib/prefs';
import type { ToolsTab } from '@/components/ToolsModal';

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
  // Panel inputs (Phase E, #73): the bills rail is now a placeable `panel`
  // widget, fed the SAME range-filtered bills + export-scope query fragments the
  // inline rail read in Dashboard.tsx, so it renders byte-identically.
  billsData: BillsPanelData;
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
    // A chart fills half the lg chart block (4 of 12 cols) and is tall (7 rows,
    // = CHART_ROWS); mirrors the default generator's two-up chart placement.
    defaultSize: { w: 4, h: 7, minW: 2, minH: 3 },
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
    // A KPI card (issue #73 iteration: fix the clipped carbon / vs-last-year /
    // budget cards). 3 of 12 cols wide so the three-fact carbon sub line
    // ("≈ N gal gas · N tree-yrs · estimate") and the two-fuel YoY row fit on one
    // line, and 3 rows tall (= STAT_ROWS, ~120px at the fit rowHeight) so the
    // budget card's title + headline + progress bar + status line aren't clipped.
    // minH=2 keeps the shortest usable card; minW=2 keeps the sub line legible.
    defaultSize: { w: 3, h: 3, minW: 2, minH: 2 },
    render: (host) => {
      const d = host.statData;
      if (spec.kind === 'simple') return <StatCard model={spec.select(d)} />;
      if (spec.kind === 'yoy') return <YoyStatCard model={spec.select(d)} openTools={host.openTools} />;
      return <BudgetStatCard model={spec.select(d)} openTools={host.openTools} />;
    },
  };
}

// The bills rail as a `panel` widget (Phase E, #73). One instance, id
// 'panel:bills'. Renders the BillsPanel from the host's range-filtered bills +
// export scopes (byte-identical to the old inline rail). It's wide (4 of 12 cols
// at lg → the right rail) and tall so it stretches the cockpit like before.
const BILLS_PANEL: WidgetDef = {
  type: 'panel:bills',
  category: 'panel',
  title: 'Bills',
  dataDeps: ['bills'],
  defaultSize: { w: 4, h: 14, minW: 2, minH: 4 },
  render: (host) => <BillsPanel data={host.billsData} />,
};

// The registry: every chart id, every stat id, plus the bills panel — keyed by
// widget type. The `chart:`/`stat:`/`panel:` prefixes keep the namespaces
// distinct in one record (RFC §3.1's `type` examples, e.g. 'tool:compare').
export const WIDGETS: Record<string, WidgetDef> = Object.fromEntries([
  ...CHART_SPECS.map((s) => [`chart:${s.id}`, chartWidget(s)] as const),
  ...STAT_SPECS.map((s) => [`stat:${s.id}`, statWidget(s)] as const),
  [BILLS_PANEL.type, BILLS_PANEL] as const,
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
  const w = WIDGETS[type];
  if (!w) throw new Error(`Unknown widget type: ${type}`);
  return w;
}
