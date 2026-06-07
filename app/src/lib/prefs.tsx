'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { CHART_SPECS } from './chartSpec';
import { mergeOrder, mergeRange } from './cockpit';
import { DEFAULT_RANGE, type RangePref } from './range';

export interface ChartConfig {
  visible: boolean;
  hidden: string[]; // hidden series keys
  type: 'bar' | 'line' | 'area'; // applies to bar-role series
  stacked: boolean;
  leftScale: 'linear' | 'log';
  rightScale: 'linear' | 'log';
}

// Density of the cockpit layout (issue #2). 'fit' packs the main view into a
// 16:9 desktop viewport with no page scroll (vh-based chart heights); 'comfortable'
// is the classic taller, page-scrolling layout. Only affects ≥1280px.
export type Density = 'fit' | 'comfortable';

export interface Prefs {
  // Range selection (issue #24). The RangePref model (preset + custom ym bounds)
  // replaces the old `rangeMonths` number; a stale rangeMonths is migrated on load.
  range: RangePref;
  currencyDecimals: number;
  density: Density;
  // Show the seasonal 12-month forward projection (issue #52). Issue #69 added a
  // single hide toggle; #71 splits it into two independent controls so the dashed
  // forward series on the cost & usage charts and the "Proj. next 12 mo" summary
  // card can be shown/hidden separately. Both default on (current behavior). A
  // saved legacy `showProjection` is migrated into both in mergePrefs().
  showProjectionOnCharts: boolean;
  showProjectionCard: boolean;
  order: string[];
  charts: Record<string, ChartConfig>;
  // The account the dashboard is scoped to. null = the default account (and the
  // only sensible value on a single-account install). Survives reload via
  // localStorage; an id that no longer exists is ignored at fetch time.
  selectedAccountId: number | null;
}

const baseChart = (over: Partial<ChartConfig> = {}): ChartConfig => ({
  visible: true,
  hidden: [],
  type: 'bar',
  stacked: true,
  leftScale: 'linear',
  rightScale: 'linear',
  ...over,
});

export const DEFAULT_PREFS: Prefs = {
  range: DEFAULT_RANGE,
  currencyDecimals: 2,
  density: 'fit',
  showProjectionOnCharts: true,
  showProjectionCard: true,
  selectedAccountId: null,
  order: CHART_SPECS.map((s) => s.id),
  charts: {
    usage: baseChart({ stacked: false }),
    cost: baseChart({ stacked: true }),
    rates: baseChart({ type: 'line' }),
    weather: baseChart({ stacked: false }),
    degreeDays: baseChart({ stacked: false }),
    normalized: baseChart({ type: 'line' }),
  },
};

const KEY = 'ngrid-prefs-v1';

export function mergePrefs(
  saved: (Partial<Prefs> & { rangeMonths?: number; showProjection?: boolean }) | null
): Prefs {
  if (!saved) return DEFAULT_PREFS;
  const charts: Record<string, ChartConfig> = {};
  for (const id of DEFAULT_PREFS.order) {
    charts[id] = { ...DEFAULT_PREFS.charts[id], ...(saved.charts?.[id] || {}) };
  }
  // Back-compat (#71): the old single `showProjection` toggle now seeds BOTH new
  // toggles, so an existing user who turned the projection off keeps it off
  // everywhere. The per-key `??` (not ||) preserves an explicit `false`; only
  // null/undefined fall through to the legacy value, then to the default.
  const legacyProjection = saved.showProjection ?? DEFAULT_PREFS.showProjectionOnCharts;
  return {
    range: mergeRange(saved),
    currencyDecimals: saved.currencyDecimals ?? DEFAULT_PREFS.currencyDecimals,
    density: saved.density === 'comfortable' || saved.density === 'fit' ? saved.density : DEFAULT_PREFS.density,
    showProjectionOnCharts: saved.showProjectionOnCharts ?? legacyProjection,
    showProjectionCard: saved.showProjectionCard ?? legacyProjection,
    selectedAccountId: saved.selectedAccountId ?? DEFAULT_PREFS.selectedAccountId,
    order: mergeOrder(saved.order, DEFAULT_PREFS.order),
    charts,
  };
}

interface Ctx {
  prefs: Prefs;
  loaded: boolean;
  setPrefs: (p: Prefs) => void;
  patch: (p: Partial<Prefs>) => void;
  updateChart: (id: string, c: Partial<ChartConfig>) => void;
  setRange: (r: RangePref) => void;
  reset: () => void;
}

const PrefsContext = createContext<Ctx | null>(null);

export function PrefsProvider({ children }: { children: React.ReactNode }) {
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      setPrefsState(mergePrefs(raw ? JSON.parse(raw) : null));
    } catch {
      setPrefsState(DEFAULT_PREFS);
    }
    setLoaded(true);
  }, []);

  const persist = useCallback((p: Prefs) => {
    setPrefsState(p);
    try {
      localStorage.setItem(KEY, JSON.stringify(p));
    } catch {
      /* ignore quota / private mode */
    }
  }, []);

  const value = useMemo<Ctx>(
    () => ({
      prefs,
      loaded,
      setPrefs: persist,
      patch: (p) => persist({ ...prefs, ...p }),
      updateChart: (id, c) => persist({ ...prefs, charts: { ...prefs.charts, [id]: { ...prefs.charts[id], ...c } } }),
      setRange: (r) => persist({ ...prefs, range: r }),
      reset: () => persist(DEFAULT_PREFS),
    }),
    [prefs, loaded, persist]
  );

  return <PrefsContext.Provider value={value}>{children}</PrefsContext.Provider>;
}

export function usePrefs(): Ctx {
  const ctx = useContext(PrefsContext);
  if (!ctx) throw new Error('usePrefs must be used within PrefsProvider');
  return ctx;
}
