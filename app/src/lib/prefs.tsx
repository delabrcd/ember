'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { mergeOrder, mergeRange } from './cockpit';
import { DEFAULT_RANGE, type RangePref } from './range';
import { DEFAULT_CHART_CONFIG, DEFAULT_CHART_ORDER, type ChartConfig } from './chartConfig';

// `ChartConfig` + the chart defaults now live in the PURE, server-safe
// lib/chartConfig.ts so the Phase D layout route (a server module) can read the
// defaults without dotting into this 'use client' module. Re-exported here so
// the 30+ existing `import { ChartConfig } from '@/lib/prefs'` sites are
// unchanged.
export type { ChartConfig };

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
  // Locally-dismissed in-app notifications (notifications-dropdown feature): the
  // stable keys (see lib/notifications.ts) of header-bell items the user has
  // dismissed. Persisted here so a dismissal sticks across reloads on this
  // browser; a dismissed key never reappears. Empty by default.
  // NOTE: superseded by the server-side notification log (notification-log
  // feature) — read/unread now lives in the DB and the bell no longer reads this.
  // Kept for back-compat with persisted prefs (additive change only).
  dismissedNotifications: string[];
  // Show ALREADY-READ items in the notifications bell (notification-log feature).
  // OFF by default — the dropdown shows only unread, with a header toggle to reveal
  // the read history (rendered muted). Persisted per-browser.
  showReadNotifications: boolean;
}

export const DEFAULT_PREFS: Prefs = {
  range: DEFAULT_RANGE,
  currencyDecimals: 2,
  density: 'fit',
  showProjectionOnCharts: true,
  showProjectionCard: true,
  selectedAccountId: null,
  dismissedNotifications: [],
  showReadNotifications: false,
  // Chart order + per-chart config defaults come from the shared, server-safe
  // lib/chartConfig.ts (the same source the Phase D server layout default uses).
  order: DEFAULT_CHART_ORDER,
  charts: DEFAULT_CHART_CONFIG,
};

// Exported so the Phase D one-time localStorage→server layout import
// (useDashboardLayout) reads the SAME v1 blob this provider persists, rather
// than hardcoding the key in two places.
export const PREFS_KEY = 'ngrid-prefs-v1';
const KEY = PREFS_KEY;

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
    // Defend against a malformed persisted value (only keep strings); default [].
    dismissedNotifications: Array.isArray(saved.dismissedNotifications)
      ? saved.dismissedNotifications.filter((k): k is string => typeof k === 'string')
      : DEFAULT_PREFS.dismissedNotifications,
    showReadNotifications: saved.showReadNotifications ?? DEFAULT_PREFS.showReadNotifications,
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
