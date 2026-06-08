// vizType → renderer registry (Phase B of the UI re-architecture, issue #94;
// RFC §3.2). A `VizSpec` declares HOW it should be drawn via its `vizType`; this
// registry maps that discriminant to the React renderer that draws it. The seam
// is what lets Phase C (issue #95) add `scatter`/`heatmap`/`profile` as a new
// renderer entry — NOT a UI rewrite, NOT a forked chart component.
//
// Phase B has exactly ONE entry: `'timeseries' → ConfigurableChart`, unchanged.
// The current generic Recharts renderer simply becomes "the timeseries
// renderer" registered by vizType. Its rendered output is byte-identical; we've
// only given the dispatch a name. The other vizTypes have no renderer yet (they
// throw if asked), so the union is type-complete while staying honest about what
// actually renders today.

import type { ReactNode } from 'react';
import type { MonthRow, VizSpec } from '@/lib/chartSpec';
import type { ChartConfig } from '@/lib/prefs';
import { ConfigurableChart } from '@/components/ConfigurableChart';
import { HeatmapViz, ProfileViz, ScatterViz } from '@/components/widgets/VizCharts';

// What every viz renderer is handed: the spec (its concrete vizType variant),
// the host-resolved rows for the spec's `dataset`, and the same fill/height
// layout knobs Dashboard has always passed the chart. `rows` is typed `unknown[]`
// at the registry boundary because each renderer consumes the row shape of its
// own dataset; the renderer narrows it (the timeseries renderer to `MonthRow[]`,
// which is exactly what its `dataset:'monthly'` resolves to).
export interface VizRenderProps {
  spec: VizSpec;
  rows: unknown[];
  fill: boolean;
  height: number;
  // Phase D (#96), timeseries only: an externally-supplied per-chart config +
  // write-back. When present, ConfigurableChart reads/writes THIS (the server
  // layout) instead of localStorage prefs; when absent it falls back to prefs
  // (the demo gallery path). The other renderers ignore these.
  config?: ChartConfig;
  onConfigChange?: (c: Partial<ChartConfig>) => void;
}

type VizRenderer = (props: VizRenderProps) => ReactNode;

// The timeseries renderer: the existing ConfigurableChart, fed the spec/rows/
// layout exactly as Dashboard's old call sites did. The spec is narrowed to the
// timeseries variant (and rows to `MonthRow[]`) — guaranteed by the registry
// only routing a `'timeseries'` spec here.
const renderTimeseries: VizRenderer = ({ spec, rows, fill, height, config, onConfigChange }) => {
  if (spec.vizType !== 'timeseries') {
    // Unreachable in Phase B (the registry routes by vizType); a defensive guard
    // so a future miswire is a loud error, not a silently mis-rendered chart.
    throw new Error(`timeseries renderer got a '${spec.vizType}' spec`);
  }
  return (
    <ConfigurableChart
      spec={spec}
      rows={rows as MonthRow[]}
      fill={fill}
      height={height}
      config={config}
      onConfigChange={onConfigChange}
    />
  );
};

// The Phase C renderers (issue #95): scatter / profile (Recharts) + heatmap
// (dependency-free SVG). Each narrows the union to its variant (guaranteed by
// the registry routing on `vizType`) and hands the spec + rows to the matching
// declarative component (components/widgets/VizCharts). `rows` is `unknown[]` at
// the boundary; the component is generic over `Row`, so we pass it straight
// through — the encoding's `keyof Row` is what makes the field reads type-safe at
// the spec's definition site (e.g. the demo specs), not here.
const renderScatter: VizRenderer = ({ spec, rows, height }) => {
  if (spec.vizType !== 'scatter') throw new Error(`scatter renderer got a '${spec.vizType}' spec`);
  return <ScatterViz spec={spec} rows={rows} height={height} />;
};

const renderHeatmap: VizRenderer = ({ spec, rows, height }) => {
  if (spec.vizType !== 'heatmap') throw new Error(`heatmap renderer got a '${spec.vizType}' spec`);
  return <HeatmapViz spec={spec} rows={rows} height={height} />;
};

const renderProfile: VizRenderer = ({ spec, rows, height }) => {
  if (spec.vizType !== 'profile') throw new Error(`profile renderer got a '${spec.vizType}' spec`);
  return <ProfileViz spec={spec} rows={rows} height={height} />;
};

// The registry. As of Phase C all four vizTypes resolve. `getVizRenderer` still
// throws on an unregistered vizType so a future miswire fails loudly rather than
// rendering nothing. The scatter/heatmap/profile entries are NOT added to
// CHART_SPECS / the default dashboard — they're reached only via the demo gallery
// (and, later, the AMI interval widgets), so the real dashboard is unchanged.
const VIZ_RENDERERS: Partial<Record<VizSpec['vizType'], VizRenderer>> = {
  timeseries: renderTimeseries,
  scatter: renderScatter,
  heatmap: renderHeatmap,
  profile: renderProfile,
};

export function getVizRenderer(vizType: VizSpec['vizType']): VizRenderer {
  const r = VIZ_RENDERERS[vizType];
  if (!r) throw new Error(`No renderer registered for vizType: ${vizType}`);
  return r;
}

// Whether a vizType has a renderer registered (used by tests + future callers
// that want to gate on availability rather than throw).
export const hasVizRenderer = (vizType: VizSpec['vizType']): boolean =>
  VIZ_RENDERERS[vizType] != null;
