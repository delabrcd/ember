// Declarative spec for each dashboard chart. The generic renderer in
// ConfigurableChart.tsx turns these into Recharts charts and the config menu is
// derived from them, so adding/altering a chart is a data change here.
//
// Phase B (issue #94; RFC §3.2) generalizes this from "a series over `MonthRow`"
// to "a VISUALIZATION over a named dataset". The change is deliberately ADDITIVE
// — the spec objects now carry a `vizType` + a `dataset`, but the timeseries
// shape (the `series: SeriesDef[]` + axis formatters + row filter) is UNCHANGED,
// so `ChartSpec` stays the name 30+ call sites import and the 7 charts render
// byte-identically. Only `'timeseries'` is implemented in Phase B; the other
// vizTypes are declared in the union so the type seam exists for Phase C
// (scatter/heatmap/profile renderers), but have no renderer yet.

import type { DatasetId } from '@/lib/datasets';

export interface MonthRow {
  ym: number;
  label: string;
  kwh: number | null;
  therms: number | null;
  elecSupply: number | null;
  gasSupply: number | null;
  elecDelivery: number | null;
  gasDelivery: number | null;
  elecBill?: number | null;
  gasBill?: number | null;
  elecRateSupply: number | null;
  gasRateSupply: number | null;
  elecRateAllIn: number | null;
  gasRateAllIn: number | null;
  // Trailing average of the effective SUPPLY $/unit (issue #48). Usage-weighted
  // over a trailing window so a slowly creeping variable supply rate stands out
  // against the noisier per-month line on the rates chart. Populated by
  // withSupplyRateTrailing() in series.ts; null until a row's window has data.
  elecRateSupplyAvg?: number | null;
  gasRateSupplyAvg?: number | null;
  avgTemp: number | null;
  billTotal: number | null;
  // Length of the bill period in days, inclusive ((periodTo - periodFrom) + 1).
  // Null when either period bound is missing. Used by the per-component
  // fixed-$/day + variable-$/unit rate model (issue #67); not charted.
  days: number | null;
  // Weather normalization (issue #5). hdd/cdd are summed over the bill period;
  // the *PerDegreeDay rates divide usage by degree-days (see series.ts for the
  // exact definitions). All null when the inputs are missing.
  hdd: number | null;
  cdd: number | null;
  kwhPerDegreeDay: number | null;
  thermsPerHdd: number | null;
  // Forward 12-month seasonal projection (issue #52). These are populated ONLY on
  // appended FUTURE rows (and the latest historical row, as the anchor so the
  // dashed line connects to the solid history) — null on every other historical
  // row. A climatological PROJECTION (degree-day normals × all-in rates), never a
  // forecast and never persisted. See lib/prediction.ts projectSeason().
  projCost?: number | null; // projected period energy cost ($)
  projKwh?: number | null; // projected electric usage (kWh)
  projTherms?: number | null; // projected gas usage (therms)
  // Carbon-footprint estimate (issue #49). LOCATION-BASED estimate: usage ×
  // published average emission factors (electricity via eGRID subregion factor,
  // gas via the EPA per-therm factor). Populated on historical rows by the pure
  // estimateEmissions() (lib/emissions.ts); null when the fuel's usage is
  // missing. kg CO2e. Has NO effect on any cost number or /api/verify.
  co2eElec?: number | null; // estimated electricity emissions (kg CO2e)
  co2eGas?: number | null; // estimated gas emissions (kg CO2e)
  co2eTotal?: number | null; // combined estimated emissions (kg CO2e)
}

export type SeriesKey = Exclude<keyof MonthRow, 'ym' | 'label'>;

export interface SeriesDef {
  key: SeriesKey;
  label: string;
  color: string;
  role: 'bar' | 'line';
  axis: 'left' | 'right';
  dash?: boolean;
}

// Fields every viz shares regardless of vizType: a stable id (registry key),
// a title/subtitle, and the `dataset` it visualizes (RFC §3.2 — the data is
// declared by name; the host resolves it). `Row` is the resolved row type of
// that dataset, so the per-vizType `encoding` is typed against the real fields.
interface VizBase<Row> {
  id: string;
  title: string;
  subtitle?: string;
  dataset: DatasetId;
  // Marker for `Row` so the generic is used at the type level even though the
  // shared fields don't otherwise reference it; the per-vizType encodings below
  // are what actually consume `Row`. (Never read at runtime.)
  __row?: Row;
}

// The TIMESERIES viz — the only one implemented in Phase B. Its "encoding" is
// today's chart shape verbatim: a list of `SeriesDef` (keyed on `MonthRow`
// fields), the two optional axis formatters, and the row `filter`. So the
// existing `CHART_SPECS` map onto it 1:1 by just adding `vizType`/`dataset`.
export interface TimeseriesVizSpec extends VizBase<MonthRow> {
  vizType: 'timeseries';
  series: SeriesDef[];
  leftFmt?: (v: number) => string;
  rightFmt?: (v: number) => string;
  filter: (r: MonthRow) => boolean;
}

// ---------------------------------------------------------------------------
// Phase C (issue #95; RFC §3.2 + Decision 3) — the three new vizTypes.
//
// Each `encoding` is a THIN, typed mapping of "which field of the dataset row
// plays which visual role" — NOT a grammar-of-graphics (Decision 3 explicitly
// rejects Vega-Lite). The renderer reads these field names off the rows; the
// PURE aggregation that turns rows → drawable points/grid/buckets lives in
// lib/viz/aggregate.ts and is hand-calc unit-tested. The spec just says WHAT to
// encode; the lib says HOW to aggregate; the renderer just draws the result.
//
// `Row` is generic so a spec is typed against the real fields of whatever
// dataset it declares: scatter-over-`monthly` keys on `MonthRow` fields
// (kwh/avgTemp/…); the interval-grain heatmap/profile key on the synthetic
// sample row (lib/viz/sampleInterval.ts) until the real `IntervalUsage` (#76)
// lands — at which point only the `dataset`/`Row` change, not the encoding shape.
// ---------------------------------------------------------------------------

// The numeric-valued fields of `Row` — the only valid targets for an axis / a
// color scale (you can't put a label on a numeric axis). For a CONCRETE `Row`
// this resolves to a UNION OF STRING LITERALS (the numeric field names), so
// picking a non-numeric field at a spec's definition site is a compile error.
// (At the registry boundary the specs are instantiated at `Row = any` — see the
// `*VizSpec` defaults below — where this is permissive, which is the point: the
// renderer doesn't know the row type and just dispatches on `vizType`.)
export type NumericKey<Row> = {
  [K in keyof Row]-?: Row[K] extends number | null | undefined ? K : never;
}[keyof Row];

// Any field of `Row` — for display-only roles like a tooltip label.
export type FieldKey<Row> = keyof Row;

// SCATTER — a cloud of (x, y) points over a dataset's rows. The canonical demo
// is usage (kWh) vs avg temperature over `monthly`. Optional `label` names a row
// field used for the point's tooltip; optional `color` is the dot color (a
// single series for v1 — multi-series scatter is a later, additive change).
export interface ScatterEncoding<Row> {
  x: NumericKey<Row>;
  y: NumericKey<Row>;
  label?: FieldKey<Row>; // row field shown in the tooltip (e.g. the month label)
  color?: string; // dot color; defaults to the elec amber token in the renderer
  xLabel?: string; // axis title override (defaults to the field name)
  yLabel?: string;
}
export interface ScatterVizSpec<Row = any> extends VizBase<Row> {
  vizType: 'scatter';
  encoding: ScatterEncoding<Row>;
}

// HEATMAP — a 2-D binned grid. The canonical use (AMI #77) is hour-of-day (x)
// × day/date (y) with a usage `value` colored by magnitude. `x`/`y` name the
// numeric bin fields on the row (e.g. `hour` 0–23 and `day` 0–N); `value` is the
// field aggregated (mean) into each cell. The renderer maps value → color via a
// min/max scale the aggregator computes (so the scale is data-driven, not magic).
export interface HeatmapEncoding<Row> {
  x: NumericKey<Row>; // column bin (e.g. hour-of-day)
  y: NumericKey<Row>; // row bin (e.g. day index / date)
  value: NumericKey<Row>; // the magnitude colored per cell
  // Optional row field holding a DISPLAY label for each y bin (e.g. a `dayLabel`
  // → 'Mon'). Display only — the binning/aggregation stays purely numeric on `y`;
  // the renderer uses this just to label rows. Multiple rows in a y bin are
  // assumed to share the label (the first seen wins).
  yLabelField?: FieldKey<Row>;
  xLabel?: string;
  yLabel?: string;
  valueLabel?: string; // legend/tooltip name for the value (e.g. 'kWh')
}
export interface HeatmapVizSpec<Row = any> extends VizBase<Row> {
  vizType: 'heatmap';
  encoding: HeatmapEncoding<Row>;
}

// PROFILE — an hour-of-day (or period-of-day) LOAD PROFILE: rows are bucketed by
// a `bucket` field (e.g. `hour` 0–23) and the `value` field is aggregated within
// each bucket (mean or median) to a single curve, optionally with a shaded
// spread band (±1 std-dev) showing how variable each hour is. This is the
// "typical day" shape #77 wants.
export interface ProfileEncoding<Row> {
  bucket: NumericKey<Row>; // the period field rows are grouped by (e.g. hour 0–23)
  value: NumericKey<Row>; // the field averaged within each bucket
  agg?: 'mean' | 'median'; // central tendency per bucket (default 'mean')
  band?: boolean; // draw a ±1σ spread band around the curve (default false)
  valueLabel?: string;
  bucketLabel?: string;
}
export interface ProfileVizSpec<Row = any> extends VizBase<Row> {
  vizType: 'profile';
  encoding: ProfileEncoding<Row>;
}

// A visualization over a typed dataset (RFC §3.2). The discriminant is
// `vizType`. As of Phase C all four are specified; the new three default their
// `Row` to `unknown` here so the union stays a simple closed set the registry
// can switch on — a concrete spec (e.g. the demo specs) supplies its real `Row`.
export type VizSpec =
  | TimeseriesVizSpec
  | ScatterVizSpec
  | HeatmapVizSpec
  | ProfileVizSpec;

// `ChartSpec` is kept as the TIMESERIES-specialized alias so the 30+ existing
// import sites (ConfigurableChart, prefs.tsx, ToolsModal, Dashboard, the
// registry, SettingsView, …) don't churn — and so `ConfigurableChart` keeps
// receiving exactly the shape it always did (`series`/`filter`/`leftFmt`/
// `rightFmt`). It is now just `TimeseriesVizSpec`, which additionally carries
// `vizType:'timeseries'` + `dataset`. Render output is unchanged.
export type ChartSpec = TimeseriesVizSpec;

const ELEC = '#f59e0b';
const ELEC_SOFT = '#fcd34d';
const GAS = '#38bdf8';
const GAS_SOFT = '#7dd3fc';
const TEMP = '#fb7185';
const TOTAL = '#e2e8f0';
const HDD = '#fb7185';
const CDD = '#38bdf8';
const PROJ = '#a78bfa'; // forward seasonal projection (issue #52) — dashed, violet
const PROJ_SOFT = '#c4b5fd';
const CO2_ELEC = '#34d399'; // carbon estimate (issue #49) — green family
const CO2_GAS = '#10b981';

const money = (v: number) => `$${v}`;
const money2 = (v: number) => `$${(+v).toFixed(2)}`;
const deg = (v: number) => `${v}°`;
const dd = (v: number) => `${Math.round(v)}`;
const num3 = (v: number) => `${(+v).toFixed(3)}`;
const kg = (v: number) => `${Math.round(v)} kg`;

// Every chart is a `timeseries` viz over the `monthly` dataset (the `MonthRow[]`
// the dashboard already builds). `vizType`/`dataset` are the only additions vs
// Phase A — the series/filter/formatters are untouched, so each spec renders
// byte-identically through the timeseries renderer.
export const CHART_SPECS: ChartSpec[] = [
  {
    id: 'usage',
    vizType: 'timeseries',
    dataset: 'monthly',
    title: 'Energy usage',
    subtitle: 'Electricity (kWh) and gas (therms) per month',
    series: [
      { key: 'kwh', label: 'kWh', color: ELEC, role: 'bar', axis: 'left' },
      { key: 'therms', label: 'therms', color: GAS, role: 'bar', axis: 'right' },
      // Forward 12-month climatological projection (issue #52) — dashed, not a forecast.
      { key: 'projKwh', label: 'Proj. kWh (next 12 mo)', color: PROJ, role: 'line', axis: 'left', dash: true },
      { key: 'projTherms', label: 'Proj. therms (next 12 mo)', color: PROJ_SOFT, role: 'line', axis: 'right', dash: true },
    ],
    filter: (r) => r.kwh != null || r.therms != null || r.projKwh != null || r.projTherms != null,
  },
  {
    id: 'cost',
    vizType: 'timeseries',
    dataset: 'monthly',
    title: 'Cost breakdown',
    subtitle: 'Supply vs delivery per fuel, with total bill',
    series: [
      { key: 'elecSupply', label: 'Elec supply', color: ELEC, role: 'bar', axis: 'left' },
      { key: 'elecDelivery', label: 'Elec delivery', color: ELEC_SOFT, role: 'bar', axis: 'left' },
      { key: 'gasSupply', label: 'Gas supply', color: GAS, role: 'bar', axis: 'left' },
      { key: 'gasDelivery', label: 'Gas delivery', color: GAS_SOFT, role: 'bar', axis: 'left' },
      { key: 'billTotal', label: 'Total bill', color: TOTAL, role: 'line', axis: 'left' },
      // Forward 12-month climatological projection (issue #52) — dashed, not a forecast.
      { key: 'projCost', label: 'Projected (next 12 mo)', color: PROJ, role: 'line', axis: 'left', dash: true },
    ],
    leftFmt: money,
    filter: (r) => r.elecSupply != null || r.gasSupply != null || r.billTotal != null || r.projCost != null,
  },
  {
    id: 'rates',
    vizType: 'timeseries',
    dataset: 'monthly',
    title: 'Effective rates',
    subtitle: 'What you pay per unit: supply (solid), recent average (faint dashed) and all-in price (dashed)',
    series: [
      { key: 'elecRateSupply', label: 'Elec supply $/kWh', color: ELEC, role: 'line', axis: 'left' },
      // Trailing-average supply rate (issue #48) — soft dashed, so a creeping
      // variable supply rate is visible against the noisier per-month line.
      { key: 'elecRateSupplyAvg', label: 'Elec supply $/kWh (recent avg)', color: ELEC_SOFT, role: 'line', axis: 'left', dash: true },
      { key: 'elecRateAllIn', label: 'Elec $/kWh (full price)', color: ELEC, role: 'line', axis: 'left', dash: true },
      { key: 'gasRateSupply', label: 'Gas supply $/therm', color: GAS, role: 'line', axis: 'right' },
      { key: 'gasRateSupplyAvg', label: 'Gas supply $/therm (recent avg)', color: GAS_SOFT, role: 'line', axis: 'right', dash: true },
      { key: 'gasRateAllIn', label: 'Gas $/therm (full price)', color: GAS, role: 'line', axis: 'right', dash: true },
    ],
    leftFmt: money2,
    rightFmt: money2,
    filter: (r) => r.elecRateSupply != null || r.gasRateSupply != null,
  },
  {
    id: 'weather',
    vizType: 'timeseries',
    dataset: 'monthly',
    title: 'Usage vs weather',
    subtitle: 'Monthly avg temperature against energy use',
    series: [
      { key: 'kwh', label: 'kWh', color: ELEC, role: 'bar', axis: 'left' },
      { key: 'therms', label: 'therms', color: GAS, role: 'bar', axis: 'left' },
      { key: 'avgTemp', label: 'Avg °F', color: TEMP, role: 'line', axis: 'right' },
    ],
    rightFmt: deg,
    filter: (r) => r.avgTemp != null && (r.kwh != null || r.therms != null),
  },
  {
    id: 'degreeDays',
    vizType: 'timeseries',
    dataset: 'monthly',
    title: 'Heating & cooling weather',
    subtitle: 'How much heating and cooling weather each bill period had',
    series: [
      { key: 'hdd', label: 'Heating', color: HDD, role: 'bar', axis: 'left' },
      { key: 'cdd', label: 'Cooling', color: CDD, role: 'bar', axis: 'left' },
    ],
    leftFmt: dd,
    filter: (r) => r.hdd != null || r.cdd != null,
  },
  {
    id: 'normalized',
    vizType: 'timeseries',
    dataset: 'monthly',
    title: 'Weather-adjusted usage',
    subtitle: 'Your energy use after accounting for how hot or cold it was — a flat line means weather explains the changes',
    series: [
      { key: 'kwhPerDegreeDay', label: 'Electricity (weather-adjusted)', color: ELEC, role: 'line', axis: 'left' },
      { key: 'thermsPerHdd', label: 'Gas (weather-adjusted)', color: GAS, role: 'line', axis: 'right' },
    ],
    leftFmt: num3,
    rightFmt: num3,
    filter: (r) => r.kwhPerDegreeDay != null || r.thermsPerHdd != null,
  },
  {
    id: 'emissions',
    vizType: 'timeseries',
    dataset: 'monthly',
    title: 'Carbon footprint (estimate)',
    subtitle: 'Estimated CO₂e per fuel each month, based on your usage and a regional grid average — not your specific plan',
    series: [
      { key: 'co2eElec', label: 'Electricity', color: CO2_ELEC, role: 'bar', axis: 'left' },
      { key: 'co2eGas', label: 'Gas', color: CO2_GAS, role: 'bar', axis: 'left' },
      { key: 'co2eTotal', label: 'Total', color: TOTAL, role: 'line', axis: 'left' },
    ],
    leftFmt: kg,
    filter: (r) => r.co2eElec != null || r.co2eGas != null,
  },
];

export const SPEC_BY_ID: Record<string, ChartSpec> = Object.fromEntries(CHART_SPECS.map((s) => [s.id, s]));

export function chartCaps(spec: ChartSpec) {
  const bars = spec.series.filter((s) => s.role === 'bar').length;
  const hasRight = spec.series.some((s) => s.axis === 'right');
  return { canType: bars > 0, canStack: bars > 1, hasRight };
}
