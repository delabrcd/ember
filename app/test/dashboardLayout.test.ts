import { describe, expect, it } from 'vitest';
import { CHART_SPECS } from '../src/lib/chartSpec';
import { DEFAULT_PREFS } from '../src/lib/prefs';
import {
  DASHBOARD_LAYOUT_VERSION,
  defaultDashboardLayout,
  importFromLocalPrefs,
  isPlausibleLayout,
  mergeDashboardLayout,
  MAX_LAYOUT_ORDER,
} from '../src/lib/dashboardLayout';

// Phase D (issue #96) dashboard-layout tests. The migration-critical risk (RFC
// §6: "migration loses a user's customization") is fenced here, hand-calculated
// in the repo's pure-logic style:
//   1. the default generator reproduces TODAY'S default order/config exactly;
//   2. mergeDashboardLayout drops unknown ids / appends new charts / fills
//      missing config / survives garbage (the mergeOrder + mergePrefs discipline);
//   3. importFromLocalPrefs maps a representative v1 blob LOSSLESSLY (order + a
//      couple of customized configs + a hidden chart).

const DEFAULT_ORDER = CHART_SPECS.map((s) => s.id);

// ---------------------------------------------------------------------------
// 1. Default generator == today's default
// ---------------------------------------------------------------------------
describe('defaultDashboardLayout (hand-calculated)', () => {
  it('uses CHART_SPECS order', () => {
    expect(defaultDashboardLayout().order).toEqual(DEFAULT_ORDER);
  });

  it('reproduces DEFAULT_PREFS per-chart config for every chart (all visible)', () => {
    const layout = defaultDashboardLayout();
    for (const id of DEFAULT_ORDER) {
      // Byte-for-byte the same config the localStorage default carried — so an
      // account with no saved layout opens to exactly today's dashboard.
      expect(layout.widgetConfig[id]).toEqual(DEFAULT_PREFS.charts[id]);
      expect(layout.widgetConfig[id].visible).toBe(true);
    }
  });

  it('stamps the current version and no Phase-E placements', () => {
    const layout = defaultDashboardLayout();
    expect(layout.version).toBe(DASHBOARD_LAYOUT_VERSION);
    expect(layout.layouts).toBeUndefined();
  });

  it('returns a fresh, independently-mutable copy each call (no shared state)', () => {
    const a = defaultDashboardLayout();
    const b = defaultDashboardLayout();
    a.widgetConfig.usage.hidden.push('kwh');
    a.order.push('zzz');
    // The second copy and the shared DEFAULT_PREFS are untouched.
    expect(b.widgetConfig.usage.hidden).toEqual([]);
    expect(b.order).toEqual(DEFAULT_ORDER);
    expect(DEFAULT_PREFS.charts.usage.hidden).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. mergeDashboardLayout — the migration safety net
// ---------------------------------------------------------------------------
describe('mergeDashboardLayout (hand-calculated)', () => {
  it('null / non-object → the full default', () => {
    expect(mergeDashboardLayout(null)).toEqual(defaultDashboardLayout());
    expect(mergeDashboardLayout(undefined)).toEqual(defaultDashboardLayout());
    expect(mergeDashboardLayout(42)).toEqual(defaultDashboardLayout());
    expect(mergeDashboardLayout('garbage')).toEqual(defaultDashboardLayout());
  });

  it('drops unknown chart ids and appends charts added since the save', () => {
    // A stale order missing the later charts, with a bogus id mixed in.
    const merged = mergeDashboardLayout({
      version: 1,
      order: ['cost', 'legacyChart', 'usage'],
      widgetConfig: {},
    });
    // Known ids kept in the user's order; bogus dropped; the rest appended in
    // CHART_SPECS order. (CHART_SPECS = usage, cost, rates, weather, degreeDays,
    // normalized, emissions.)
    expect(merged.order).toEqual(['cost', 'usage', 'rates', 'weather', 'degreeDays', 'normalized', 'emissions']);
  });

  it('fills missing config from defaults but preserves saved fields per-key', () => {
    const merged = mergeDashboardLayout({
      order: DEFAULT_ORDER,
      // Only `usage` has a (partial) saved config; an explicit visible:false and
      // a hidden series must survive, while the unspecified fields fall back to
      // the usage default (stacked:false).
      widgetConfig: { usage: { visible: false, hidden: ['therms'] } },
    });
    expect(merged.widgetConfig.usage.visible).toBe(false); // explicit false survives
    expect(merged.widgetConfig.usage.hidden).toEqual(['therms']);
    expect(merged.widgetConfig.usage.stacked).toBe(false); // from the usage default
    expect(merged.widgetConfig.usage.type).toBe('bar'); // from the default
    // A chart with no saved entry is filled entirely from its default.
    expect(merged.widgetConfig.rates).toEqual(DEFAULT_PREFS.charts.rates);
  });

  it('repairs garbage config field-by-field (bad type/scale/hidden)', () => {
    const merged = mergeDashboardLayout({
      order: DEFAULT_ORDER,
      widgetConfig: {
        usage: { type: 'pie', leftScale: 'bogus', stacked: 'yes', hidden: [1, 'kwh', null] },
      },
    });
    const u = merged.widgetConfig.usage;
    expect(u.type).toBe('bar'); // bad enum → default
    expect(u.leftScale).toBe('linear'); // bad enum → default
    expect(u.stacked).toBe(false); // non-boolean → usage default
    expect(u.hidden).toEqual(['kwh']); // only string entries kept
  });

  it('carries an opaque Phase-E layouts blob through unread', () => {
    const placements = { lg: [{ i: 'usage', x: 0, y: 0, w: 6, h: 4 }] };
    const merged = mergeDashboardLayout({ order: DEFAULT_ORDER, widgetConfig: {}, layouts: placements });
    expect(merged.layouts).toEqual(placements);
    // A non-object/array layouts value is dropped (not carried as junk).
    expect(mergeDashboardLayout({ order: DEFAULT_ORDER, layouts: [] }).layouts).toBeUndefined();
    expect(mergeDashboardLayout({ order: DEFAULT_ORDER, layouts: 'x' }).layouts).toBeUndefined();
  });

  it('a complete, already-current layout round-trips unchanged', () => {
    const def = defaultDashboardLayout();
    expect(mergeDashboardLayout(def)).toEqual(def);
  });
});

// ---------------------------------------------------------------------------
// 3. importFromLocalPrefs — lossless v1 → server mapping
// ---------------------------------------------------------------------------
describe('importFromLocalPrefs (hand-calculated)', () => {
  it('null / empty → the default layout', () => {
    expect(importFromLocalPrefs(null)).toEqual(defaultDashboardLayout());
    expect(importFromLocalPrefs(undefined)).toEqual(defaultDashboardLayout());
    expect(importFromLocalPrefs({})).toEqual(defaultDashboardLayout());
  });

  it('maps a representative v1 blob losslessly: reordered, a hidden chart, customized configs', () => {
    // A returning user: rates moved to front, the emissions chart HIDDEN, the
    // cost chart switched to unstacked with gas delivery hidden, rates forced to
    // a log left scale. Their order predates `normalized`/`emissions` being last
    // (they're present though), so nothing should be appended/dropped here.
    const v1 = {
      order: ['rates', 'usage', 'cost', 'weather', 'degreeDays', 'normalized', 'emissions'],
      charts: {
        cost: { stacked: false, hidden: ['gasDelivery'] },
        rates: { leftScale: 'log' as const },
        emissions: { visible: false },
      },
    };
    const layout = importFromLocalPrefs(v1);

    // Order preserved verbatim (all ids known, none missing).
    expect(layout.order).toEqual(v1.order);

    // cost: explicit unstacked + hidden series survive; other fields default.
    expect(layout.widgetConfig.cost.stacked).toBe(false);
    expect(layout.widgetConfig.cost.hidden).toEqual(['gasDelivery']);
    expect(layout.widgetConfig.cost.visible).toBe(true);

    // rates: log scale survives; the rates default is type:'line'.
    expect(layout.widgetConfig.rates.leftScale).toBe('log');
    expect(layout.widgetConfig.rates.type).toBe('line');

    // emissions: hidden survives.
    expect(layout.widgetConfig.emissions.visible).toBe(false);

    // An untouched chart equals its default exactly.
    expect(layout.widgetConfig.usage).toEqual(DEFAULT_PREFS.charts.usage);
  });

  it('a v1 blob predating later charts gets them appended (mergeOrder discipline)', () => {
    const layout = importFromLocalPrefs({ order: ['usage', 'cost', 'rates'] });
    expect(layout.order).toEqual(DEFAULT_ORDER); // the rest appended in spec order
  });
});

// ---------------------------------------------------------------------------
// 4. isPlausibleLayout — the API parse guard
// ---------------------------------------------------------------------------
describe('isPlausibleLayout (hand-calculated)', () => {
  it('accepts a well-formed (or empty) layout', () => {
    expect(isPlausibleLayout(defaultDashboardLayout())).toBe(true);
    expect(isPlausibleLayout({})).toBe(true);
    expect(isPlausibleLayout({ order: ['usage'], widgetConfig: {} })).toBe(true);
  });

  it('rejects junk: non-object, non-array order, non-object widgetConfig, oversized order', () => {
    expect(isPlausibleLayout(null)).toBe(false);
    expect(isPlausibleLayout('x')).toBe(false);
    expect(isPlausibleLayout({ order: 'nope' })).toBe(false);
    expect(isPlausibleLayout({ widgetConfig: 5 })).toBe(false);
    expect(isPlausibleLayout({ order: new Array(MAX_LAYOUT_ORDER + 1).fill('x') })).toBe(false);
  });
});
