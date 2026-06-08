import { describe, expect, it } from 'vitest';
import { CHART_SPECS, type MonthRow } from '../src/lib/chartSpec';
import type { DatasetId, DatasetResolver } from '../src/lib/datasets';
import { getVizRenderer, hasVizRenderer } from '../src/lib/widgets/vizRenderers';
import { WIDGETS, chartWidgetType } from '../src/lib/widgets/registry';

// Phase B (issue #94) dataset-layer tests, in the repo's pure-logic style. Three
// concerns:
//   1. The dataset resolver returns the right rows for `'monthly'` (and only
//      `'monthly'` is resolvable in Phase B).
//   2. Every CHART_SPECS entry is a well-formed `timeseries` VizSpec over the
//      `'monthly'` dataset, and the chart-widget declares it as its only dataDep.
//   3. The vizType → renderer registry resolves `'timeseries'` and ONLY that in
//      Phase B; the spec → widget mapping is intact.

// A minimal MonthRow factory (mirrors widgets.test.ts / the series tests).
const mkRow = (over: Partial<MonthRow>): MonthRow => ({
  ym: 0, label: '', kwh: null, therms: null,
  elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
  elecBill: null, gasBill: null,
  elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
  avgTemp: null, billTotal: null, days: null,
  hdd: null, cdd: null, kwhPerDegreeDay: null, thermsPerHdd: null, ...over,
});

// A stand-in host resolver that mirrors Dashboard.resolveDataset: `'monthly'`
// returns per-id rows from a fixture map; anything else throws. We thread the
// widget id through so the test asserts the resolver IS keyed on the id (the
// seam that preserves the per-chart #71/#52 projection view).
const monthlyByChart: Record<string, MonthRow[]> = {
  usage: [mkRow({ ym: 202601, label: 'Jan', kwh: 100, therms: 50 })],
  cost: [mkRow({ ym: 202601, label: 'Jan', billTotal: 192.5 })],
};
const resolver: DatasetResolver = (dataset, id) => {
  if (dataset === 'monthly') return (monthlyByChart[id] ?? []) as never;
  throw new Error(`Dataset '${dataset}' is not resolvable in Phase B`);
};

// ---------------------------------------------------------------------------
// 1. Dataset resolver
// ---------------------------------------------------------------------------
describe('dataset resolver (Phase B)', () => {
  it('resolves the monthly dataset to that chart id\'s rows', () => {
    expect(resolver('monthly', 'usage')).toBe(monthlyByChart.usage);
    expect(resolver('monthly', 'cost')).toBe(monthlyByChart.cost);
  });

  it('returns an empty array for a monthly id with no rows (never undefined)', () => {
    expect(resolver('monthly', 'unknown-chart')).toEqual([]);
  });

  it('throws for any non-monthly dataset (the others are reserved in Phase B)', () => {
    for (const id of ['bills', 'overview', 'interval'] as DatasetId[]) {
      expect(() => resolver(id, 'x')).toThrow(/not resolvable/);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Every chart spec is a timeseries VizSpec over 'monthly'
// ---------------------------------------------------------------------------
describe('CHART_SPECS are timeseries VizSpecs over the monthly dataset', () => {
  it('every spec declares vizType=timeseries and dataset=monthly', () => {
    expect(CHART_SPECS.length).toBe(7);
    for (const s of CHART_SPECS) {
      expect(s.vizType, `${s.id} vizType`).toBe('timeseries');
      expect(s.dataset, `${s.id} dataset`).toBe('monthly');
    }
  });

  it('every spec keeps its timeseries shape (series[] + a filter fn)', () => {
    for (const s of CHART_SPECS) {
      expect(Array.isArray(s.series), `${s.id} series`).toBe(true);
      expect(s.series.length, `${s.id} non-empty series`).toBeGreaterThan(0);
      expect(typeof s.filter, `${s.id} filter`).toBe('function');
    }
  });

  it('each chart-widget declares exactly its spec.dataset as its only dataDep', () => {
    for (const s of CHART_SPECS) {
      const w = WIDGETS[chartWidgetType(s.id)];
      expect(w.dataDeps, `${s.id} dataDeps`).toEqual([s.dataset]);
      expect(w.dataDeps).toEqual(['monthly']);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. vizType → renderer registry
// ---------------------------------------------------------------------------
describe('vizType → renderer registry (Phase B)', () => {
  it('resolves a renderer for timeseries', () => {
    expect(hasVizRenderer('timeseries')).toBe(true);
    expect(typeof getVizRenderer('timeseries')).toBe('function');
  });

  it('resolves a renderer for the Phase-C vizTypes too (registered in #95)', () => {
    for (const v of ['scatter', 'heatmap', 'profile'] as const) {
      expect(hasVizRenderer(v)).toBe(true);
      expect(typeof getVizRenderer(v)).toBe('function');
    }
  });

  it('every chart spec routes to a registered renderer (its vizType resolves)', () => {
    for (const s of CHART_SPECS) {
      expect(() => getVizRenderer(s.vizType)).not.toThrow();
    }
  });
});
