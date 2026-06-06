'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { CHART_SPECS } from './chartSpec';
import { DEFAULT_RANGE, migrateRangeMonths, type RangePref, type RangePreset } from './range';

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

// Split a list into fixed-size pages (issue #38: paginated chart panels in the
// "fit" density). `perPage` is clamped to ≥1 so a bad caller can't divide by zero
// or loop forever; an empty input yields no pages. PURE — unit-tested. Exported
// for the cockpit (page through the visible charts in their chosen order) and tests.
export function paginate<T>(items: readonly T[], perPage: number): T[][] {
  const size = Math.max(1, Math.floor(perPage));
  const pages: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    pages.push(items.slice(i, i + size));
  }
  return pages;
}

// Wrap/clamp a desired page index to the valid range for a given page count, so
// the cockpit's prev/next arrows can never select an out-of-range page even if
// the visible-chart set shrinks underneath the active index. Returns 0 when there
// are no pages. PURE — unit-tested. Exported for the cockpit and tests.
export function clampPage(index: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(Math.max(0, Math.floor(index)), pageCount - 1);
}

// The saved blob may predate the RangePref model (issue #24): older prefs carry
// a `rangeMonths` number instead of a `range` object. Resolve the range from
// whichever is present — a real `range` wins; otherwise migrate `rangeMonths`;
// otherwise the default. A partial/garbage `range` is repaired field-by-field.
// PURE — unit-tested. The `rangeMonths` legacy field is read here but never
// written back, so it ages out of a returning user's stored prefs.
const VALID_PRESETS: RangePreset[] = ['all', 'ytd', '12mo', '24mo', '36mo', 'custom'];

export function mergeRange(saved: { range?: unknown; rangeMonths?: number } | null | undefined): RangePref {
  const r = saved?.range as Partial<RangePref> | undefined;
  if (r && typeof r === 'object' && typeof r.preset === 'string' && VALID_PRESETS.includes(r.preset as RangePreset)) {
    return {
      preset: r.preset as RangePreset,
      fromYm: typeof r.fromYm === 'number' ? r.fromYm : null,
      toYm: typeof r.toYm === 'number' ? r.toYm : null,
    };
  }
  if (saved && typeof saved.rangeMonths === 'number') return migrateRangeMonths(saved.rangeMonths);
  return { ...DEFAULT_RANGE };
}

export function mergePrefs(saved: (Partial<Prefs> & { rangeMonths?: number }) | null): Prefs {
  if (!saved) return DEFAULT_PREFS;
  const charts: Record<string, ChartConfig> = {};
  for (const id of DEFAULT_PREFS.order) {
    charts[id] = { ...DEFAULT_PREFS.charts[id], ...(saved.charts?.[id] || {}) };
  }
  return {
    range: mergeRange(saved),
    currencyDecimals: saved.currencyDecimals ?? DEFAULT_PREFS.currencyDecimals,
    density: saved.density === 'comfortable' || saved.density === 'fit' ? saved.density : DEFAULT_PREFS.density,
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
