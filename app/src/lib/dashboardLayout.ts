// Server-side, per-account DASHBOARD DEFINITION (Phase D of the UI
// re-architecture, issue #96; RFC §3.4 + Decision 4). This is the pure core of
// the layout-persistence work: the versioned shape, a default generator, a
// robust merge, and a one-time localStorage→server import — all with NO DB /
// React / fetch dependency, so they're hand-calc unit-tested in isolation (the
// same discipline cockpit.ts/prefs.tsx follow). The API route (app/src/app/api/
// dashboard/layout/route.ts) and the client hook (useDashboardLayout) lean on
// these; the arithmetic-free but migration-critical logic lives here.
//
// WHAT THIS OWNS vs prefs.tsx — the §3.4 split:
//   • SERVER, per-account (this module): the dashboard DEFINITION — which chart
//     widgets exist, their ORDER, each chart's CONFIG (hidden series / type /
//     stacked / scales — the existing `ChartConfig`), and per-chart VISIBILITY.
//     Portable: a user's dashboard follows them across browsers/devices and is
//     captured by the existing DB backup.
//   • BROWSER, ephemeral (prefs.tsx localStorage, UNCHANGED): genuinely
//     per-device/transient prefs — `range`, `density`, `currencyDecimals`, the
//     projection toggles, `selectedAccountId`, and the notification prefs. These
//     stay in localStorage; do NOT move them here.
//   Document any NEW pref on the correct side: "is it the dashboard definition?"
//   → here; "is it a per-browser display/ephemeral choice?" → prefs.tsx.

import { mergeOrder } from './cockpit';
import { DEFAULT_CHART_CONFIG, DEFAULT_CHART_ORDER, type ChartConfig } from './chartConfig';
import type { Placements } from './layoutEngine';

// Bumped only on a BREAKING shape change; `mergeDashboardLayout` already repairs
// additive/partial drift, so a minor field addition does NOT need a bump.
export const DASHBOARD_LAYOUT_VERSION = 1;

// PHASE E (issue #73) now OWNS this. The react-grid-layout placement engine's
// serializable per-breakpoint placements (`Placements` = the concrete
// `Record<Breakpoint, Placement[]>` from layoutEngine.ts) live on this same blob
// (RFC §3.4). Phase D reserved this field as an opaque passthrough; Phase E fills
// in the real type. `mergeDashboardLayout` still carries it through merges
// untouched (it's the layout engine — not this module — that repairs placements
// via mergePlacements, since that needs the live visible-widget set the host
// builds). A round-trip therefore preserves a Phase-E layout verbatim.
export type DashboardPlacements = Placements;

// The dashboard definition blob. Versioned + forward-compatible.
export interface DashboardLayout {
  version: number;
  // Chart widget order — the ids in CHART_SPECS order by default. Same role as
  // today's `prefs.order`. Drives both the dashboard render order and the
  // Settings reorder list.
  order: string[];
  // Per-chart config (hidden series / type / stacked / scales) AND per-chart
  // visibility — the existing `ChartConfig` verbatim, so the render path is
  // byte-identical to reading `prefs.charts[id]` today. Keyed by chart id.
  widgetConfig: Record<string, ChartConfig>;
  // PHASE E owns this — see DashboardPlacements above. Optional + opaque in Phase
  // D: carried through merges untouched, never generated, never read.
  layouts?: DashboardPlacements;
  // PINNED STAT STRIP toggle (issue #73 iteration). When true (the DEFAULT,
  // today's behaviour) the stat cards render in a FIXED band at the top of the
  // fit cockpit — always visible, NOT paginated — and only the chart/panel tiles
  // page below it. When false the stat cards become ordinary tiles that paginate
  // with everything else (the full "phone home screen" feel). Rides this same
  // server blob (NO schema change); the Customize-mode toggle flips it.
  pinnedStatStrip: boolean;
}

// The default for the pinned-stat-strip toggle: ON, reproducing today's
// always-visible stat strip. A saved blob without the field falls through to
// this (the per-key `??` discipline), so an existing user is unchanged.
export const DEFAULT_PINNED_STAT_STRIP = true;

// Produce EXACTLY today's default dashboard: CHART_SPECS order, the per-chart
// default configs from DEFAULT_PREFS.charts (all charts visible), no placements.
// An account with no saved layout opens to today's dashboard. We clone off
// DEFAULT_PREFS so the two defaults can never drift — the chart defaults still
// have a single source of truth (prefs.tsx baseChart(...)).
export function defaultDashboardLayout(): DashboardLayout {
  const order = [...DEFAULT_CHART_ORDER];
  const widgetConfig: Record<string, ChartConfig> = {};
  for (const id of order) {
    // Deep-enough copy: ChartConfig is flat except `hidden` (string[]); copy
    // that array so a caller mutating the result can't poison the default.
    const base = DEFAULT_CHART_CONFIG[id];
    widgetConfig[id] = { ...base, hidden: [...base.hidden] };
  }
  return { version: DASHBOARD_LAYOUT_VERSION, order, widgetConfig, pinnedStatStrip: DEFAULT_PINNED_STAT_STRIP };
}

// A constant default (the common read path returns this when nothing is saved).
// Generated once; callers that need to MUTATE should call defaultDashboardLayout()
// for a fresh copy instead.
export const DEFAULT_DASHBOARD_LAYOUT: DashboardLayout = defaultDashboardLayout();

// Repair a saved/partial/old/garbage blob into a valid DashboardLayout — the
// migration safety net (RFC §6: "migration loses a user's customization" is the
// named risk). REUSES the tested mergeOrder discipline (drop unknown chart ids,
// append newly-added charts, keep the user's ordering) and mergePrefs's per-key
// `??` back-compat (a missing config field falls through to the default; an
// explicit value — including `false`/`[]` — survives). PURE — unit-tested.
export function mergeDashboardLayout(saved: unknown): DashboardLayout {
  const def = defaultDashboardLayout();
  if (!saved || typeof saved !== 'object') return def;
  const s = saved as Partial<DashboardLayout> & Record<string, unknown>;

  // Order: mergeOrder drops unknown ids + appends charts added since the save,
  // preserving the user's positions — identical to how prefs.order migrates.
  const order = mergeOrder(Array.isArray(s.order) ? (s.order as string[]) : undefined, def.order);

  // Per-chart config: fill EVERY known chart from defaults, then overlay the
  // saved fields per-key so a partial/garbage saved entry can't drop a field or
  // smuggle in an extra one. We only read the known config keys (no spread of an
  // untrusted object), and validate each against the default's shape.
  const savedConfig = (s.widgetConfig && typeof s.widgetConfig === 'object' ? s.widgetConfig : {}) as Record<
    string,
    unknown
  >;
  const widgetConfig: Record<string, ChartConfig> = {};
  for (const id of order) {
    widgetConfig[id] = mergeChartConfig(def.widgetConfig[id], savedConfig[id]);
  }

  // PHASE E passthrough: carry an opaque `layouts` blob verbatim if present and
  // object-shaped, so a Phase-E layout survives a Phase-D round-trip. Phase D
  // never reads or generates it.
  const layouts =
    s.layouts && typeof s.layouts === 'object' && !Array.isArray(s.layouts)
      ? (s.layouts as DashboardPlacements)
      : undefined;

  // Pinned-stat-strip toggle (issue #73 iteration): keep an explicit boolean,
  // else fall through to the default (the per-key `??` defends an explicit
  // `false`, never a truthiness test).
  const pinnedStatStrip = typeof s.pinnedStatStrip === 'boolean' ? s.pinnedStatStrip : DEFAULT_PINNED_STAT_STRIP;

  const base: DashboardLayout = { version: DASHBOARD_LAYOUT_VERSION, order, widgetConfig, pinnedStatStrip };
  return layouts ? { ...base, layouts } : base;
}

// Repair ONE chart's config against its default. Each field validated to the
// default's type; anything missing/garbage falls back to the default (the
// per-key `??`/typeof discipline from mergePrefs). Defends an explicit `false`
// (visible/stacked) — we use `typeof === 'boolean'`, never a truthiness test.
function mergeChartConfig(def: ChartConfig, saved: unknown): ChartConfig {
  if (!saved || typeof saved !== 'object') return { ...def, hidden: [...def.hidden] };
  const c = saved as Partial<ChartConfig> & Record<string, unknown>;
  return {
    visible: typeof c.visible === 'boolean' ? c.visible : def.visible,
    // Keep only string entries; a non-array / garbage `hidden` → the default [].
    hidden: Array.isArray(c.hidden) ? c.hidden.filter((k): k is string => typeof k === 'string') : [...def.hidden],
    type: c.type === 'bar' || c.type === 'line' || c.type === 'area' ? c.type : def.type,
    stacked: typeof c.stacked === 'boolean' ? c.stacked : def.stacked,
    leftScale: c.leftScale === 'linear' || c.leftScale === 'log' ? c.leftScale : def.leftScale,
    rightScale: c.rightScale === 'linear' || c.rightScale === 'log' ? c.rightScale : def.rightScale,
  };
}

// The legacy v1 localStorage prefs blob shape this import reads — just the two
// fields that map to the dashboard definition (`order` + `charts`). Everything
// else in the blob stays a per-browser pref and is NOT imported.
export interface V1PrefsLike {
  order?: string[];
  charts?: Record<string, Partial<ChartConfig>>;
}

// One-time localStorage→server import (RFC §3.4 step 2). Map a returning user's
// existing `ngrid-prefs-v1` `order`+`charts` LOSSLESSLY into a DashboardLayout
// so their exact chart order / visibility / per-chart config carries over to the
// server. PURE — unit-tested. We funnel through mergeDashboardLayout so the same
// drop-unknown / append-new / fill-missing discipline applies (a v1 blob that
// predates a chart still gets it appended; a customized chart's hidden-series /
// type / scale survive). The caller PUTs the result once and marks it imported.
export function importFromLocalPrefs(v1: V1PrefsLike | null | undefined): DashboardLayout {
  if (!v1 || typeof v1 !== 'object') return defaultDashboardLayout();
  return mergeDashboardLayout({ order: v1.order, widgetConfig: v1.charts });
}

// Defensive parse guard for the API PUT body (the route is access-gated, but we
// still validate the parse — bad input must never poison a stored layout).
// Returns true for a plausibly-well-formed blob; the route then runs it through
// mergeDashboardLayout, which canonicalizes it regardless. A cap on `order`
// length keeps a hostile/oversized body from bloating the row.
export const MAX_LAYOUT_ORDER = 200;

export function isPlausibleLayout(body: unknown): body is Partial<DashboardLayout> {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (b.order !== undefined && !Array.isArray(b.order)) return false;
  if (Array.isArray(b.order) && b.order.length > MAX_LAYOUT_ORDER) return false;
  if (b.widgetConfig !== undefined && (typeof b.widgetConfig !== 'object' || b.widgetConfig === null)) return false;
  return true;
}
