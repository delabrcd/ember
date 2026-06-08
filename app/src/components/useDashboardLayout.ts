'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChartConfig } from '@/lib/prefs';
import { PREFS_KEY } from '@/lib/prefs';
import {
  type DashboardLayout,
  importFromLocalPrefs,
  mergeDashboardLayout,
} from '@/lib/dashboardLayout';
import type { Placements } from '@/lib/layoutEngine';

// Client owner of the SERVER-SIDE dashboard definition (Phase D, issue #96; RFC
// §3.4). This is the server counterpart to prefs.tsx: prefs.tsx keeps owning the
// per-browser/ephemeral half (range, density, currencyDecimals, projection
// toggles, selectedAccountId, notification prefs) in localStorage; THIS hook owns
// the portable dashboard DEFINITION (chart order + per-chart config +
// visibility), fetched async from /api/dashboard/layout and persisted back with
// a PUT. See dashboardLayout.ts for the field-by-field split rationale.
//
// THE NO-FIRST-PAINT-FLASH CONTRACT. localStorage was synchronous, so the old
// dashboard had its order/config on the very first paint. The server layout
// arrives async, so we expose `layoutLoading` and the dashboard renders a
// SKELETON for the chart region while it's true — never a flash of the DEFAULT
// layout that then snaps to the user's saved one. `layout` is null until the
// first fetch resolves; callers MUST gate on `!layoutLoading` (or `layout`)
// before reading order/config.

export interface DashboardLayoutState {
  // The resolved layout, or null until the first fetch for the active account
  // resolves. Callers render the skeleton while loading rather than reading this.
  layout: DashboardLayout | null;
  // True while the layout for the current account is being fetched (or the
  // one-time import is in flight). Drives the chart-region skeleton.
  layoutLoading: boolean;
  // Replace the whole layout (optimistic local update + PUT). Used by a future
  // bulk editor; the granular helpers below cover today's edits.
  setLayout: (next: DashboardLayout) => void;
  // Patch one chart's config (visibility / hidden series / type / scales) —
  // mirrors prefs.updateChart's optimistic-then-persist shape.
  updateChart: (id: string, c: Partial<ChartConfig>) => void;
  // Replace the chart order (Settings reorder). Optimistic + PUT.
  reorder: (order: string[]) => void;
  // Replace the per-breakpoint RGL placements (Phase E, #73): drag/resize/add/
  // remove all funnel through here — optimistic local update + a THROTTLED PUT so
  // a drag doesn't fire a request per pixel. The placements live on the same blob
  // as order/config (RFC §3.4), so this writes the whole DashboardLayout back.
  setPlacements: (layouts: Placements) => void;
  // Flip the pinned-stat-strip toggle (issue #73 iteration). Rides the same blob;
  // optimistic local update + PUT, like updateChart/reorder.
  setPinnedStatStrip: (pinned: boolean) => void;
}

// Read the legacy v1 localStorage prefs blob for the one-time import. Returns
// only the two fields the import maps (order + charts); a missing/garbage blob
// yields null so the import is skipped (the account keeps the server default).
function readV1Prefs(): { order?: string[]; charts?: Record<string, Partial<ChartConfig>> } | null {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { order?: string[]; charts?: Record<string, Partial<ChartConfig>> };
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

// Build the scope query the API route reads (?accountId=), matching the rest of
// the dashboard's per-account fetches. null = the default account.
const scopeOf = (accountId: number | null) => (accountId != null ? `?accountId=${accountId}` : '');

// `ready` mirrors prefs `loaded`: wait until the selection is resolved so the
// first fetch already targets the right account (no fetch-for-default-then-
// refetch churn). `selectedAccountId` is the validated selection from
// useDashboardData; the hook RE-FETCHES whenever it changes (layouts are
// per-account) — exactly like the overview/series/bills fetches.
export function useDashboardLayout(selectedAccountId: number | null, ready: boolean): DashboardLayoutState {
  const [layout, setLayoutState] = useState<DashboardLayout | null>(null);
  const [layoutLoading, setLayoutLoading] = useState(true);

  // Guards the one-time import PER ACCOUNT: once we've imported (or confirmed the
  // server already has a layout) for an account id, we never import again for it,
  // so a later server edit can't be clobbered by a stale localStorage blob. Keyed
  // by account id (null → a sentinel) since the layout is per-account.
  const importedFor = useRef<Set<number | string>>(new Set());

  const scope = scopeOf(selectedAccountId);
  const acctKey: number | string = selectedAccountId ?? '__default__';

  // Persist: optimistic local update, then PUT the canonical layout. On a PUT
  // failure we keep the optimistic local state (the next successful save or a
  // reload reconciles) — same forgiving posture as prefs.tsx's localStorage
  // persist (which swallows quota/private-mode errors).
  const persist = useCallback(
    (next: DashboardLayout) => {
      setLayoutState(next);
      fetch(`/api/dashboard/layout${scope}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      }).catch(() => {
        /* keep optimistic state; a later save/reload reconciles */
      });
    },
    [scope]
  );

  // Fetch (and, if needed, one-time import) the layout for the active account.
  // Re-runs on account change. An AbortController + a stale-guard ref ensure a
  // slow fetch for a previous account can't overwrite a newer one's result.
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    setLayoutLoading(true);
    (async () => {
      try {
        const res = await fetch(`/api/dashboard/layout${scope}`, { cache: 'no-store' });
        const data = (await res.json()) as { layout: unknown; imported?: boolean };
        if (cancelled) return;

        // ONE-TIME IMPORT (RFC §3.4 step 2). Only when the server has NO layout
        // yet for this account (imported=false) AND we haven't already imported
        // for it this session. If a v1 localStorage blob with order/charts
        // exists, map it losslessly and PUT it once; otherwise adopt the server
        // default. Marking imported (regardless of branch) means a subsequent
        // server edit is never re-clobbered by the localStorage blob.
        if (data.imported === false && !importedFor.current.has(acctKey)) {
          importedFor.current.add(acctKey);
          const v1 = readV1Prefs();
          if (v1 && (v1.order || v1.charts)) {
            const imported = importFromLocalPrefs(v1);
            setLayoutState(imported);
            setLayoutLoading(false);
            // Persist the import once so it survives reloads / other devices.
            fetch(`/api/dashboard/layout${scope}`, {
              method: 'PUT',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(imported),
            }).catch(() => {
              /* the local state still reflects the import this session */
            });
            return;
          }
        }

        // Normal path: adopt the server layout (canonicalized defensively in case
        // an older/partial blob slipped through).
        setLayoutState(mergeDashboardLayout(data.layout));
        setLayoutLoading(false);
      } catch {
        if (cancelled) return;
        // Network/parse failure: fall back to the default so the dashboard still
        // renders (it just renders the default layout, not a broken state).
        setLayoutState(mergeDashboardLayout(null));
        setLayoutLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, scope, acctKey]);

  const setLayout = useCallback((next: DashboardLayout) => persist(next), [persist]);

  // The granular edits read the current layout through a ref so the callbacks
  // stay stable AND we never mutate inside a setState updater (which React's
  // StrictMode double-invokes). The edit is a no-op until the layout has loaded
  // (the Settings UI only renders these controls once it has).
  const layoutRef = useRef<DashboardLayout | null>(null);
  layoutRef.current = layout;

  const updateChart = useCallback(
    (id: string, c: Partial<ChartConfig>) => {
      const cur = layoutRef.current;
      if (!cur) return;
      persist({
        ...cur,
        widgetConfig: { ...cur.widgetConfig, [id]: { ...cur.widgetConfig[id], ...c } },
      });
    },
    [persist]
  );

  const reorder = useCallback(
    (order: string[]) => {
      const cur = layoutRef.current;
      if (!cur) return;
      persist({ ...cur, order });
    },
    [persist]
  );

  const setPinnedStatStrip = useCallback(
    (pinned: boolean) => {
      const cur = layoutRef.current;
      if (!cur) return;
      persist({ ...cur, pinnedStatStrip: pinned });
    },
    [persist]
  );

  // Placement edits (Phase E, #73). A drag/resize fires RGL's onLayoutChange
  // many times in quick succession, so we update local state IMMEDIATELY
  // (optimistic, keeps the grid responsive) but DEBOUNCE the PUT — only the last
  // placement in a burst hits the server. The timer is cleared on unmount /
  // account change so a stale write can't land after we've moved on.
  const placeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setPlacements = useCallback((layouts: Placements) => {
    const cur = layoutRef.current;
    if (!cur) return;
    const next: DashboardLayout = { ...cur, layouts };
    setLayoutState(next); // optimistic, no flicker mid-drag
    if (placeTimer.current) clearTimeout(placeTimer.current);
    placeTimer.current = setTimeout(() => {
      fetch(`/api/dashboard/layout${scope}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(next),
      }).catch(() => {
        /* keep optimistic state; a later save/reload reconciles */
      });
    }, 400);
  }, [scope]);

  // Flush/clear the debounce timer when the account scope changes or on unmount,
  // so a pending PUT for the previous account never lands on the new one.
  useEffect(() => {
    return () => {
      if (placeTimer.current) clearTimeout(placeTimer.current);
    };
  }, [scope]);

  return { layout, layoutLoading, setLayout, updateChart, reorder, setPlacements, setPinnedStatStrip };
}
