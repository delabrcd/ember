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
import { CHART_SPECS, type ChartSpec, type MonthRow } from '@/lib/chartSpec';
import { STAT_SPECS, type StatData, type StatSpec } from '@/lib/widgets/statSpec';
import { ConfigurableChart } from '@/components/ConfigurableChart';
import { BudgetStatCard, StatCard, YoyStatCard } from '@/components/widgets/StatCard';
import type { ToolsTab } from '@/components/ToolsModal';

// The host context every widget render can read. Phase A keeps charts and stats
// on their existing, separate data sources (the dataset abstraction is Phase B),
// so the host hands each kind exactly what its old JSX consumed:
//   • chart widgets: the spec/rows adapter (preserves #71/#52 projection logic)
//     plus the fill/height layout knobs Dashboard already passes ConfigurableChart.
//   • stat widgets: the StatData bag + the openTools callback for the two
//     clickable cards.
export interface WidgetHost {
  // Chart adapters — IDENTICAL to Dashboard.tsx's specFor()/chartRows(), passed
  // in so the projection stripping/append stays in one place and the rendered
  // output is unchanged.
  specFor: (id: string) => ChartSpec;
  chartRows: (id: string) => MonthRow[];
  chartFill: boolean;
  chartHeight: number;
  // Stat inputs.
  statData: StatData;
  openTools: (tab: ToolsTab) => void;
}

// Minimal WidgetDef for Phase A (RFC §3.1, trimmed). `defaultSize` is a stub
// placeholder for the layout engine (Phase E) — present so the shape is forward-
// compatible, unused today.
export interface WidgetDef {
  type: string; // registry key
  category: 'chart' | 'stat' | 'tool' | 'panel';
  title: string;
  defaultSize: { w: number; h: number };
  render: (host: WidgetHost) => ReactNode;
}

// Build a chart-widget for one ChartSpec. The render reuses ConfigurableChart
// exactly as Dashboard did, pulling the (possibly projection-stripped) spec and
// the (possibly projection-appended) rows from the host adapter so output is
// byte-identical. `key`/wrapper div are the caller's responsibility (it controls
// the grid cell), matching the old `.map((id) => <div key={id}>…)` structure.
function chartWidget(spec: ChartSpec): WidgetDef {
  return {
    type: `chart:${spec.id}`,
    category: 'chart',
    title: spec.title,
    defaultSize: { w: 1, h: 1 },
    render: (host) => (
      <ConfigurableChart
        spec={host.specFor(spec.id)}
        rows={host.chartRows(spec.id)}
        fill={host.chartFill}
        height={host.chartHeight}
      />
    ),
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
    defaultSize: { w: 1, h: 1 },
    render: (host) => {
      const d = host.statData;
      if (spec.kind === 'simple') return <StatCard model={spec.select(d)} />;
      if (spec.kind === 'yoy') return <YoyStatCard model={spec.select(d)} openTools={host.openTools} />;
      return <BudgetStatCard model={spec.select(d)} openTools={host.openTools} />;
    },
  };
}

// The registry: every chart id and every stat id, keyed by widget type. The
// `chart:`/`stat:` prefixes keep the two namespaces distinct in one record (RFC
// §3.1's `type` examples, e.g. 'tool:compare').
export const WIDGETS: Record<string, WidgetDef> = Object.fromEntries([
  ...CHART_SPECS.map((s) => [`chart:${s.id}`, chartWidget(s)] as const),
  ...STAT_SPECS.map((s) => [`stat:${s.id}`, statWidget(s)] as const),
]);

// Type-keyed accessors so callers don't hand-build the prefixed string. A
// missing key throws — a chart/stat that isn't registered is a bug, not a
// silent no-render (the registry-completeness test guards this).
export const chartWidgetType = (id: string) => `chart:${id}`;
export const statWidgetType = (id: string) => `stat:${id}`;

export function getWidget(type: string): WidgetDef {
  const w = WIDGETS[type];
  if (!w) throw new Error(`Unknown widget type: ${type}`);
  return w;
}
