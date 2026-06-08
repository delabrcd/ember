import { describe, expect, it } from 'vitest';
import { CHART_SPECS } from '../src/lib/chartSpec';
import type { Overview } from '../src/components/useDashboardData';
import { WIDGETS, chartWidgetType, statWidgetType, getWidget } from '../src/lib/widgets/registry';
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
    }
  });

  it('registers a stat-widget for every stat spec', () => {
    for (const id of STAT_IDS) {
      const w = WIDGETS[statWidgetType(id)];
      expect(w, `stat:${id} missing`).toBeTruthy();
      expect(w.category).toBe('stat');
      expect(getWidget(statWidgetType(id))).toBe(w);
    }
  });

  it('has exactly chart+stat entries and no namespace collision', () => {
    // 7 charts + 8 stats = 15 widgets; the prefixes keep them distinct.
    expect(CHART_SPECS.length).toBe(7);
    expect(STAT_IDS.length).toBe(8);
    expect(Object.keys(WIDGETS).length).toBe(CHART_SPECS.length + STAT_IDS.length);
    expect(new Set(Object.keys(WIDGETS)).size).toBe(15);
  });

  it('throws on an unknown widget type (a missing registration is a bug)', () => {
    expect(() => getWidget('chart:does-not-exist')).toThrow();
    expect(() => getWidget('stat:does-not-exist')).toThrow();
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
  it('latest bill: amount + statement date', () => {
    const spec = STAT_SPEC_BY_ID.latestBill;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(mkData({ latestBill: { statementDate: '2026-05-01', totalDueAmount: 192.5 } }));
    expect(m).toEqual({ title: 'Latest bill', value: '$192.50', sub: 'May 1, 2026' });
  });

  it('lifetime spend: whole-dollar + bill count', () => {
    const spec = STAT_SPEC_BY_ID.lifetimeSpend;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(mkData({ lifetimeSpend: 12345.67, billCount: 30 }));
    expect(m).toEqual({ title: 'Lifetime spend', value: '$12,346', sub: 'across 30 bills' });
  });

  it('electric rate: all-in $/kWh with unit span + supply-part sub', () => {
    const spec = STAT_SPEC_BY_ID.elecRate;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(mkData({}, { elecAllIn: 0.2456, lastRow: mkLastRow({ elecRateSupply: 0.1 }) }));
    expect(m.value).toEqual({ lead: '$0.246', unit: '/kWh' });
    expect(m.sub).toBe('full price, last 12 mo · supply part $0.100');
  });

  it('gas rate: 2-dp all-in $/therm with unit span + supply-part sub', () => {
    const spec = STAT_SPEC_BY_ID.gasRate;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(mkData({}, { gasAllIn: 1.234, lastRow: mkLastRow({ gasRateSupply: 0.9 }) }));
    expect(m.value).toEqual({ lead: '$1.23', unit: '/therm' });
    expect(m.sub).toBe('full price, last 12 mo · supply part $0.90');
  });

  it('rate cards show — for a null rate', () => {
    const elec = STAT_SPEC_BY_ID.elecRate;
    if (elec.kind !== 'simple') throw new Error('expected simple');
    const m = elec.select(mkData({}, { elecAllIn: null, lastRow: undefined }));
    expect(m.value).toEqual({ lead: '—', unit: '/kWh' });
    expect(m.sub).toBe('full price, last 12 mo · supply part —');
  });

  it('est-next: ~point, low–high range, and the estimate tooltip (amber)', () => {
    const spec = STAT_SPEC_BY_ID.nextBillEstimate;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(mkData({ nextBillEstimate: { point: 192.24, low: 170, high: 215, basis: 'a Kalman model' } }));
    expect(m.title).toBe('Est. next bill');
    expect(m.value).toBe('~$192.24');
    expect(m.sub).toBe('$170.00–$215.00');
    expect(m.tooltip?.accent).toBe('amber');
    expect(m.tooltip?.text).toBe('Estimated from a Kalman model. Not a real charge.');
  });

  it('carbon: rounded kg with unit span, equivalence sub, emerald tooltip', () => {
    const spec = STAT_SPEC_BY_ID.emissions;
    if (spec.kind !== 'simple') throw new Error('expected simple');
    const m = spec.select(
      mkData({ emissions: { elecKg: 100, gasKg: 200, totalKg: 1234.6, gallonsGasoline: 138.9, treeYears: 20.4 } })
    );
    expect(m.value).toEqual({ lead: '~1,235', unit: ' kg CO₂e' });
    expect(m.sub).toBe('≈ 139 gal gas · 20 tree-yrs · estimate');
    expect(m.tooltip?.accent).toBe('emerald');
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
