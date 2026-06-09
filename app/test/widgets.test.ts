import { describe, expect, it } from 'vitest';
import { CHART_SPECS } from '../src/lib/chartSpec';
import type { Overview } from '../src/components/useDashboardData';
import { WIDGETS, BILLS_PANEL_TYPE, INTERVAL_WIDGET_TYPE, SPACER_PREFIX, chartWidgetType, statWidgetType, getWidget, isSpacerId, widgetMins } from '../src/lib/widgets/registry';
import type { MonthRow } from '../src/lib/chartSpec';
import {
  STAT_IDS,
  STAT_SPEC_BY_ID,
  yoyDeltaClass,
  type StatData,
} from '../src/lib/widgets/statSpec';

// Minimal MonthRow factory (mirrors the other pure-series tests). Only the
// supply-rate fields matter for the rate-card subs.
const mkLastRow = (over: Partial<MonthRow>): MonthRow => ({
  ym: 0, label: '', kwh: null, therms: null,
  elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
  elecBill: null, gasBill: null,
  elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
  avgTemp: null, billTotal: null, days: null,
  hdd: null, cdd: null, kwhPerDegreeDay: null, thermsPerHdd: null, ...over,
});

// Phase A (issue #93) widget-registry tests. Two concerns, hand-calculated in
// the repo's pure-logic style:
//   1. Registry completeness — every chart id and every stat id is registered,
//      lookups resolve, and the two namespaces don't collide.
//   2. StatSpec isVisible predicates + value selectors against hand-built
//      StatData fixtures (the bag the cards read). The selectors are PURE, so we
//      assert the exact strings/numbers/class tokens they emit.

// A StatData fixture from a partial Overview. The selectors only read `ov`, the
// two trailing rates, lastRow, and currencyDecimals — supply just those.
const mkData = (
  ov: Partial<Overview> | null,
  over: Partial<Omit<StatData, 'ov'>> = {}
): StatData => ({
  ov: ov as Overview | null,
  elecAllIn: null,
  gasAllIn: null,
  lastRow: undefined,
  currencyDecimals: 2,
  rateCardMode: 'avg',
  ...over,
});

// ---------------------------------------------------------------------------
// 1. Registry completeness
// ---------------------------------------------------------------------------
describe('widget registry completeness', () => {
  it('registers a chart-widget for every chart spec', () => {
    for (const s of CHART_SPECS) {
      const w = WIDGETS[chartWidgetType(s.id)];
      expect(w, `chart:${s.id} missing`).toBeTruthy();
      expect(w.category).toBe('chart');
      expect(getWidget(chartWidgetType(s.id))).toBe(w);
      // Phase B (#94): a chart-widget declares exactly its spec's dataset as its
      // single dataDep, so the host knows what to resolve for it.
      expect(w.dataDeps, `chart:${s.id} dataDeps`).toEqual([s.dataset]);
    }
  });

  it('registers a stat-widget for every stat spec', () => {
    for (const id of STAT_IDS) {
      const w = WIDGETS[statWidgetType(id)];
      expect(w, `stat:${id} missing`).toBeTruthy();
      expect(w.category).toBe('stat');
      expect(getWidget(statWidgetType(id))).toBe(w);
      // Stat widgets read the `ov` bag off the host directly in Phase A/B, so
      // they declare no dataset deps yet.
      expect(w.dataDeps, `stat:${id} dataDeps`).toEqual([]);
    }
  });

  it('has exactly chart+stat+panel+interval+spacer entries and no namespace collision', () => {
    // 7 charts + 8 stats + 1 panel (the bills rail, Phase E #73) + 1 interval
    // load-shape widget (#76) + 1 spacer prototype (CHANGE 2) = 18 registry entries;
    // the chart:/stat:/panel:/interval/spacer keys keep them distinct. (The spacer is
    // stored under its bare prefix; concrete `spacer:<n>` instances resolve to it in
    // getWidget — they're not extra entries.)
    expect(CHART_SPECS.length).toBe(7);
    expect(STAT_IDS.length).toBe(8);
    expect(Object.keys(WIDGETS).length).toBe(CHART_SPECS.length + STAT_IDS.length + 3);
    expect(new Set(Object.keys(WIDGETS)).size).toBe(18);
  });

  it('registers the bills panel (Phase E #73) as a placeable panel widget', () => {
    const w = WIDGETS[BILLS_PANEL_TYPE];
    expect(w).toBeTruthy();
    expect(w.category).toBe('panel');
    expect(getWidget(BILLS_PANEL_TYPE)).toBe(w);
    expect(w.dataDeps).toEqual(['bills']);
  });

  it('registers the interval load-shape widget (#76) as a self-contained chart tile', () => {
    const w = WIDGETS[INTERVAL_WIDGET_TYPE];
    expect(w).toBeTruthy();
    expect(w.category).toBe('chart');
    expect(getWidget(INTERVAL_WIDGET_TYPE)).toBe(w);
    // It SELF-FETCHES /api/interval, so it declares no dataset deps (it never goes
    // through resolveDataset / specFor).
    expect(w.dataDeps).toEqual([]);
    // Sized like a chart tile so it lays out in the 2×2 chart grid.
    expect(w.defaultSize.w).toBe(6);
  });

  it('throws on an unknown widget type (a missing registration is a bug)', () => {
    expect(() => getWidget('chart:does-not-exist')).toThrow();
    expect(() => getWidget('stat:does-not-exist')).toThrow();
  });

  it('resolves any spacer:<n> instance to the one spacer prototype (CHANGE 2)', () => {
    const proto = getWidget(SPACER_PREFIX);
    expect(proto.category).toBe('tool');
    expect(proto.title).toBe('Spacer');
    // Multi-instance: every concrete spacer id resolves to the SAME prototype def.
    expect(getWidget('spacer:1')).toBe(proto);
    expect(getWidget('spacer:2')).toBe(proto);
    expect(getWidget('spacer:42')).toBe(proto);
    // isSpacerId distinguishes a concrete instance from the bare prefix / other ids.
    expect(isSpacerId('spacer:1')).toBe(true);
    expect(isSpacerId('spacer:99')).toBe(true);
    expect(isSpacerId('spacer')).toBe(false); // the bare prototype key, not an instance
    expect(isSpacerId('stat:budget')).toBe(false);
    // The prototype respects the min-size floor (minW/minH ≥ 1).
    expect(proto.defaultSize.minW).toBeGreaterThanOrEqual(1);
    expect(proto.defaultSize.minH).toBeGreaterThanOrEqual(1);
  });

  it('widgetMins resolves a placed spacer instance to its prototype floor', () => {
    const mins = widgetMins(['spacer:1', 'spacer:7']);
    expect(mins['spacer:1']).toEqual({ minW: 1, minH: 1 });
    expect(mins['spacer:7']).toEqual({ minW: 1, minH: 1 });
  });

  it('keeps the 4 fixed cards first, then the optional cards, in render order', () => {
    expect(STAT_IDS).toEqual([
      'latestBill',
      'lifetimeSpend',
      'elecRate',
      'gasRate',
      'nextBillEstimate',
      'emissions',
      'yoy',
      'budget',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2a. isVisible predicates
// ---------------------------------------------------------------------------
describe('StatSpec isVisible predicates', () => {
  const fixed = ['latestBill', 'lifetimeSpend', 'elecRate', 'gasRate'];

  it('the 4 fixed cards are always visible (even with an empty overview)', () => {
    for (const id of fixed) {
      expect(STAT_SPEC_BY_ID[id].isVisible(mkData({}))).toBe(true);
      expect(STAT_SPEC_BY_ID[id].isVisible(mkData(null))).toBe(true);
    }
  });

  it('est-next shows only when ov.nextBillEstimate is present', () => {
    const spec = STAT_SPEC_BY_ID.nextBillEstimate;
    expect(spec.isVisible(mkData({}))).toBe(false);
    expect(spec.isVisible(mkData({ nextBillEstimate: { point: 1, low: 0, high: 2, basis: 'x' } }))).toBe(true);
  });

  it('carbon shows only when ov.emissions is present', () => {
    const spec = STAT_SPEC_BY_ID.emissions;
    expect(spec.isVisible(mkData({}))).toBe(false);
    expect(
      spec.isVisible(mkData({ emissions: { elecKg: 1, gasKg: 1, totalKg: 2, gallonsGasoline: 1, treeYears: 1 } }))
    ).toBe(true);
  });

  it('vs-last-year mirrors showYoyCard: visible when at least one fuel matched', () => {
    const spec = STAT_SPEC_BY_ID.yoy;
    const fuel = (normalizedPct: number) => ({
      fuel: 'elec' as const,
      usageA: 0, usageB: 0, ddA: 1, ddB: 1, intensityA: 0, intensityB: 0,
      rawUsageDelta: 0, rawUsagePct: 0, ddPct: 0, weatherExplainedDelta: 0, intensityDelta: 0,
      normalizedPct, rate: null, normCostA: null, normCostB: null, normCostDelta: null,
    });
    // none matched → both null → hidden
    expect(spec.isVisible(mkData({ latestYoy: { elec: null, gas: null } }))).toBe(false);
    expect(spec.isVisible(mkData({ latestYoy: null }))).toBe(false);
    expect(spec.isVisible(mkData({}))).toBe(false);
    // elec only / gas only / both → visible
    expect(spec.isVisible(mkData({ latestYoy: { elec: fuel(-0.05), gas: null } }))).toBe(true);
    expect(spec.isVisible(mkData({ latestYoy: { elec: null, gas: fuel(0.03) } }))).toBe(true);
    expect(spec.isVisible(mkData({ latestYoy: { elec: fuel(-0.05), gas: fuel(0.03) } }))).toBe(true);
  });

  it('budget shows only when ov.budget is present', () => {
    const spec = STAT_SPEC_BY_ID.budget;
    expect(spec.isVisible(mkData({}))).toBe(false);
    expect(spec.isVisible(mkData({ budget: mkBudget('on_track') }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2b. Value selectors (simple cards)
// ---------------------------------------------------------------------------
describe('StatSpec selectors — simple cards', () => {
  // The compact-stat-cards iteration: the card body is now just the brief title +
  // the headline value; the old sub/detail line MOVED into the ⓘ tooltip. So every
  // simple card carries a `tooltip` and no `sub`, with a shorter title.
  it('latest bill: amount only, statement date in the tooltip', () => {
    const spec = STAT_SPEC_BY_ID.latestBill;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(mkData({ latestBill: { statementDate: '2026-05-01', totalDueAmount: 192.5 } }));
    expect(m.title).toBe('Latest bill');
    expect(m.value).toBe('$192.50');
    expect(m.tooltip.accent).toBe('amber');
    expect(m.tooltip.text).toBe('Amount due on your latest statement, dated May 1, 2026.');
    // The detail no longer renders as a card sub line.
    expect('sub' in m).toBe(false);
  });

  it('lifetime: whole-dollar, bill count in the tooltip, brief title', () => {
    const spec = STAT_SPEC_BY_ID.lifetimeSpend;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(mkData({ lifetimeSpend: 12345.67, billCount: 30 }));
    expect(m.title).toBe('Lifetime');
    expect(m.value).toBe('$12,346');
    expect(m.tooltip.text).toBe('Total spent across all 30 bills on record.');
  });

  it('electric rate (avg mode): 2-dp all-in $/kWh, flick label, supply + both modes in the tooltip', () => {
    const spec = STAT_SPEC_BY_ID.elecRate;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(
      mkData({}, { elecAllIn: 0.2456, lastRow: mkLastRow({ elecRateAllIn: 0.31, elecRateSupply: 0.1 }), rateCardMode: 'avg' })
    );
    expect(m.title).toBe('Elec');
    // Trimmed to 2 decimals so the card fits w=1 ($0.25/kWh, not $0.246/kWh).
    expect(m.value).toEqual({ lead: '$0.25', unit: '/kWh' });
    expect(m.flick).toEqual({ label: 'avg' });
    expect(m.tooltip.text).toContain('12-MONTH AVERAGE');
    expect(m.tooltip.text).toContain('12-mo average $0.25/kWh; current $0.31/kWh');
    expect(m.tooltip.text).toContain('supply part of your latest bill is $0.10/kWh');
  });

  it('electric rate (current mode): headline flips to the latest month all-in rate', () => {
    const spec = STAT_SPEC_BY_ID.elecRate;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(
      mkData({}, { elecAllIn: 0.2456, lastRow: mkLastRow({ elecRateAllIn: 0.31, elecRateSupply: 0.1 }), rateCardMode: 'current' })
    );
    // CURRENT = lastRow.elecRateAllIn, not the trailing-12 average.
    expect(m.value).toEqual({ lead: '$0.31', unit: '/kWh' });
    expect(m.flick).toEqual({ label: 'now' });
    expect(m.tooltip.text).toContain('CURRENT (latest month)');
  });

  it('gas rate (avg vs current): flicks between the 12-mo average and the latest all-in rate', () => {
    const spec = STAT_SPEC_BY_ID.gasRate;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const avg = spec.select(
      mkData({}, { gasAllIn: 1.234, lastRow: mkLastRow({ gasRateAllIn: 1.6, gasRateSupply: 0.9 }), rateCardMode: 'avg' })
    );
    expect(avg.title).toBe('Gas');
    expect(avg.value).toEqual({ lead: '$1.23', unit: '/therm' });
    expect(avg.flick).toEqual({ label: 'avg' });
    const cur = spec.select(
      mkData({}, { gasAllIn: 1.234, lastRow: mkLastRow({ gasRateAllIn: 1.6, gasRateSupply: 0.9 }), rateCardMode: 'current' })
    );
    expect(cur.value).toEqual({ lead: '$1.60', unit: '/therm' });
    expect(cur.tooltip.text).toContain('supply part of your latest bill is $0.90/therm');
  });

  it('rate cards show — for a null rate (both modes)', () => {
    const elec = STAT_SPEC_BY_ID.elecRate;
    if (elec.kind !== 'simple') throw new Error('expected simple');
    const avg = elec.select(mkData({}, { elecAllIn: null, lastRow: undefined, rateCardMode: 'avg' }));
    expect(avg.value).toEqual({ lead: '—', unit: '/kWh' });
    expect(avg.tooltip.text).toContain('supply part of your latest bill is —/kWh');
    const cur = elec.select(mkData({}, { elecAllIn: null, lastRow: undefined, rateCardMode: 'current' }));
    expect(cur.value).toEqual({ lead: '—', unit: '/kWh' });
  });

  it('est-next: ~point headline; low–high range + estimate basis in the tooltip (amber)', () => {
    const spec = STAT_SPEC_BY_ID.nextBillEstimate;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(mkData({ nextBillEstimate: { point: 192.24, low: 170, high: 215, basis: 'a Kalman model' } }));
    expect(m.title).toBe('Est. next');
    expect(m.value).toBe('~$192.24');
    expect(m.tooltip.accent).toBe('amber');
    expect(m.tooltip.text).toBe('Likely range $170.00–$215.00. Estimated from a Kalman model. Not a real charge.');
  });

  it('carbon: rounded kg headline; equivalences + caveat in the emerald tooltip', () => {
    const spec = STAT_SPEC_BY_ID.emissions;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(
      mkData({ emissions: { elecKg: 100, gasKg: 200, totalKg: 1234.6, gallonsGasoline: 138.9, treeYears: 20.4 } })
    );
    expect(m.title).toBe('Carbon');
    expect(m.value).toEqual({ lead: '~1,235', unit: ' kg' });
    expect(m.tooltip.accent).toBe('emerald');
    expect(m.tooltip.text).toContain('139 gal of gasoline');
    expect(m.tooltip.text).toContain('20 tree-years');
  });
});

// ---------------------------------------------------------------------------
// 2c. Value selectors (bespoke cards) + yoyDeltaClass
// ---------------------------------------------------------------------------
describe('yoyDeltaClass (hand-calculated)', () => {
  it('lower usage = emerald, higher = rose, ~flat/null = slate', () => {
    expect(yoyDeltaClass(-0.05)).toBe('text-emerald-300'); // used less = good
    expect(yoyDeltaClass(0.05)).toBe('text-rose-300'); // used more = bad
    expect(yoyDeltaClass(0.004)).toBe('text-slate-200'); // within ±0.005 epsilon
    expect(yoyDeltaClass(0)).toBe('text-slate-200');
    expect(yoyDeltaClass(null)).toBe('text-slate-200');
    expect(yoyDeltaClass(undefined)).toBe('text-slate-200');
  });
});

const mkYoyFuel = (normalizedPct: number) => ({
  fuel: 'elec' as const,
  usageA: 0, usageB: 0, ddA: 1, ddB: 1, intensityA: 0, intensityB: 0,
  rawUsageDelta: 0, rawUsagePct: 0, ddPct: 0, weatherExplainedDelta: 0, intensityDelta: 0,
  normalizedPct, rate: null, normCostA: null, normCostB: null, normCostDelta: null,
});

describe('StatSpec selector — vs last year (yoy)', () => {
  const spec = STAT_SPEC_BY_ID.yoy;
  if (spec.kind !== 'yoy') throw new Error('expected yoy');

  it('elec-only: gas slot null, elec signed % + emerald (used less)', () => {
    const m = spec.select(mkData({ latestYoy: { elec: mkYoyFuel(-0.06), gas: null } }));
    expect(m.gas).toBeNull();
    expect(m.elec).toEqual({ pct: '−6%', cls: 'text-emerald-300' });
  });

  it('gas-only: elec slot null, gas signed % + rose (used more)', () => {
    const m = spec.select(mkData({ latestYoy: { elec: null, gas: mkYoyFuel(0.06) } }));
    expect(m.elec).toBeNull();
    expect(m.gas).toEqual({ pct: '+6%', cls: 'text-rose-300' });
  });

  it('both fuels populated', () => {
    const m = spec.select(mkData({ latestYoy: { elec: mkYoyFuel(-0.02), gas: mkYoyFuel(0.0) } }));
    expect(m.elec?.pct).toBe('−2%');
    expect(m.gas).toEqual({ pct: '0%', cls: 'text-slate-200' });
  });
});

function mkBudget(status: 'over' | 'under' | 'on_track'): NonNullable<Overview['budget']> {
  // Hand-built so the geometry is checkable: target 1000, spent 600, projected
  // depends on status so the bar/label assertions are deterministic.
  const base = {
    window: { fromYm: 202601, toYm: 202612 },
    target: 1000,
    spent: 600,
    billsCounted: 6,
    remaining: 0,
    remainingLow: 600,
    remainingHigh: 600,
    remainingPeriods: 0,
    projectedLow: 0,
    projectedHigh: 0,
  };
  if (status === 'over') return { ...base, projected: 1200, delta: 200, status };
  if (status === 'under') return { ...base, projected: 800, delta: -200, status };
  return { ...base, projected: 1000, delta: 0, status };
}

describe('StatSpec selector — budget', () => {
  const spec = STAT_SPEC_BY_ID.budget;
  if (spec.kind !== 'budget') throw new Error('expected budget');

  it('on_track: projected = target, neutral label/color, year from window', () => {
    const m = spec.select(mkData({ budget: mkBudget('on_track') }));
    expect(m.fromY).toBe(2026);
    expect(m.projected).toBe('$1,000');
    expect(m.target).toBe('$1,000');
    expect(m.statusLabel).toBe('on track');
    expect(m.statusColor).toBe('text-slate-200');
    expect(m.over).toBe(false);
    // denom = max(1000,1000,1) = 1000; spent 600 → 60%; projected==spent... here
    // projected 1000 so rem = (1000-600)/1000 = 40%; target tick at 100%.
    expect(m.spentPct).toBe(60);
    expect(m.remPct).toBe(40);
    expect(m.targetPct).toBe(100);
  });

  it('over: rose, "over by $X", bar fills past target (denom = projected)', () => {
    const m = spec.select(mkData({ budget: mkBudget('over') }));
    expect(m.over).toBe(true);
    expect(m.statusColor).toBe('text-rose-300');
    expect(m.statusLabel).toBe('over by $200');
    // The status detail moved into the ⓘ tooltip (compact-stat-cards iteration).
    expect(m.tooltip).toContain('over by $200');
    // denom = max(1000,1200,1) = 1200; spent 600 → 50%; rem (1200-600)/1200=50%;
    // target tick at 1000/1200 = 83.33%.
    expect(m.spentPct).toBe(50);
    expect(m.remPct).toBe(50);
    expect(m.targetPct).toBeCloseTo(83.333, 2);
  });

  it('under: emerald, "under by $X"', () => {
    const m = spec.select(mkData({ budget: mkBudget('under') }));
    expect(m.over).toBe(false);
    expect(m.statusColor).toBe('text-emerald-300');
    expect(m.statusLabel).toBe('under by $200');
  });
});
