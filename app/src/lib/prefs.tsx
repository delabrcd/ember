'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { CHART_SPECS } from './chartSpec';

export interface ChartConfig {
  visible: boolean;
  hidden: string[]; // hidden series keys
  type: 'bar' | 'line' | 'area'; // applies to bar-role series
  stacked: boolean;
  leftScale: 'linear' | 'log';
  rightScale: 'linear' | 'log';
}

export interface Prefs {
  rangeMonths: number; // 0 = all
  currencyDecimals: number;
  // When true, the main "Energy usage" chart shows WEATHER-NORMALIZED usage
  // (kWh per degree-day, therms per HDD) instead of raw kWh/therms. Persisted so
  // the operator's choice sticks; the header carries the obvious on/off toggle.
  normalizeWeather: boolean;
  order: string[];
  charts: Record<string, ChartConfig>;
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
  rangeMonths: 0,
  currencyDecimals: 2,
  normalizeWeather: false,
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

// Merge a saved chart order with the current default order. Keeps the user's
// existing order/positions but APPENDS any chart ids that didn't exist when they
// last saved (e.g. the weather/degree-days/normalized charts added later) and
// drops ids that no longer exist. PURE — unit-tested. Without this, charts added
// after a user's prefs were first written never appear for them. Exported for tests.
export function mergeOrder(savedOrder: string[] | undefined, defaultOrder: string[]): string[] {
  const known = new Set(defaultOrder);
  const saved = (savedOrder ?? []).filter((id) => known.has(id));
  const seen = new Set(saved);
  const appended = defaultOrder.filter((id) => !seen.has(id));
  return [...saved, ...appended];
}

export function mergePrefs(saved: Partial<Prefs> | null): Prefs {
  if (!saved) return DEFAULT_PREFS;
  const charts: Record<string, ChartConfig> = {};
  for (const id of DEFAULT_PREFS.order) {
    charts[id] = { ...DEFAULT_PREFS.charts[id], ...(saved.charts?.[id] || {}) };
  }
  return {
    rangeMonths: saved.rangeMonths ?? DEFAULT_PREFS.rangeMonths,
    currencyDecimals: saved.currencyDecimals ?? DEFAULT_PREFS.currencyDecimals,
    normalizeWeather: saved.normalizeWeather ?? DEFAULT_PREFS.normalizeWeather,
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
