// Per-chart config shape + its defaults — the PURE, server-safe core shared by
// the client prefs provider (prefs.tsx, a 'use client' module) AND the
// server-side dashboard-layout module/route (dashboardLayout.ts, imported by an
// API route). It lives here, with NO 'use client' / React / DOM, so a server
// component/route can dot into `DEFAULT_CHART_CONFIG` without Next.js's "cannot
// access X on the server / can't dot into a client module" error — which is
// exactly what happens if a route imports these off prefs.tsx.
//
// `ChartConfig` is the per-chart customization the dashboard persists: which
// series are hidden, the bar-role type, stacking, and per-axis scale, plus the
// chart's visibility. Phase A–C read it from localStorage prefs; Phase D (#96)
// moves it server-side, but the SHAPE and the DEFAULTS stay defined once, here.

import { CHART_SPECS } from './chartSpec';

export interface ChartConfig {
  visible: boolean;
  hidden: string[]; // hidden series keys
  type: 'bar' | 'line' | 'area'; // applies to bar-role series
  stacked: boolean;
  leftScale: 'linear' | 'log';
  rightScale: 'linear' | 'log';
}

// One chart's default config; `over` tweaks the per-chart deviations below.
export const baseChart = (over: Partial<ChartConfig> = {}): ChartConfig => ({
  visible: true,
  hidden: [],
  type: 'bar',
  stacked: true,
  leftScale: 'linear',
  rightScale: 'linear',
  ...over,
});

// The default per-chart config map — the single source of truth for "what each
// chart looks like out of the box". DEFAULT_PREFS.charts (prefs.tsx) and
// defaultDashboardLayout() (dashboardLayout.ts) both build off THIS, so the two
// defaults can never drift. Keyed by chart id (CHART_SPECS ids).
export const DEFAULT_CHART_CONFIG: Record<string, ChartConfig> = {
  usage: baseChart({ stacked: false }),
  cost: baseChart({ stacked: true }),
  rates: baseChart({ type: 'line' }),
  weather: baseChart({ stacked: false }),
  degreeDays: baseChart({ stacked: false }),
  normalized: baseChart({ type: 'line' }),
  emissions: baseChart({ stacked: false }),
};

// The default chart ORDER — CHART_SPECS order. Shared so prefs.order and the
// layout's default order stay in lockstep.
export const DEFAULT_CHART_ORDER: string[] = CHART_SPECS.map((s) => s.id);
