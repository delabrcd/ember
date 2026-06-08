// Pure aggregation + rate math, independent of the database so it can be unit
// tested with hand-calculated inputs. queries.ts feeds it DB rows; the dashboard
// uses trailing12AllIn for the headline rate cards.
import type { MonthRow } from './chartSpec';
import { ymLabel } from './ym';

export interface UsageInput { periodYearMonth: number; usageType: string; quantity: number }
export interface CostInput { periodYearMonth: number; fuelType: string; kind: string; amount: number }
export interface WeatherInput { ym: number; avgTemperature: number }
export interface BillInput { ym: number; totalDueAmount: number | null; days?: number | null }
// Degree-days already summed (per bill period) by the caller, keyed to the same
// `ym` the rest of the pipeline uses (ymOf(statementDate)).
export interface DegreeDayInput { ym: number; hdd: number; cdd: number }

export interface SeriesInput {
  usages: UsageInput[];
  costs: CostInput[];
  weather: WeatherInput[];
  bills: BillInput[];
  degreeDays?: DegreeDayInput[];
}

const div = (a: number | null, b: number | null) => (a != null && b != null && b > 0 ? a / b : null);
const sum = (a: number | null, b: number | null) => (a == null && b == null ? null : (a ?? 0) + (b ?? 0));

export function deriveMonthlySeries(input: SeriesInput): MonthRow[] {
  const months = new Map<number, MonthRow>();
  const get = (ym: number): MonthRow => {
    let r = months.get(ym);
    if (!r) {
      r = {
        ym, label: ymLabel(ym),
        kwh: null, therms: null,
        elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
        elecBill: null, gasBill: null,
        elecRateSupply: null, gasRateSupply: null, elecRateAllIn: null, gasRateAllIn: null,
        avgTemp: null, billTotal: null, days: null,
        hdd: null, cdd: null, kwhPerDegreeDay: null, thermsPerHdd: null,
      };
      months.set(ym, r);
    }
    return r;
  };

  for (const u of input.usages) {
    if (!u.periodYearMonth) continue;
    const r = get(u.periodYearMonth);
    if (/KWH/i.test(u.usageType)) r.kwh = u.quantity;
    else if (/THERM/i.test(u.usageType)) r.therms = u.quantity;
  }
  for (const c of input.costs) {
    if (!c.periodYearMonth) continue;
    const r = get(c.periodYearMonth);
    const elec = /ELEC/i.test(c.fuelType);
    if (c.kind === 'SUPPLY') elec ? (r.elecSupply = c.amount) : (r.gasSupply = c.amount);
    else if (c.kind === 'DELIVERY') elec ? (r.elecDelivery = c.amount) : (r.gasDelivery = c.amount);
  }
  for (const w of input.weather) get(w.ym).avgTemp = w.avgTemperature;
  for (const b of input.bills) {
    const r = get(b.ym);
    if (b.totalDueAmount != null) r.billTotal = b.totalDueAmount;
    if (b.days != null) r.days = b.days;
  }
  for (const d of input.degreeDays ?? []) {
    const r = get(d.ym);
    r.hdd = d.hdd;
    r.cdd = d.cdd;
  }

  for (const r of months.values()) {
    r.elecBill = sum(r.elecSupply, r.elecDelivery);
    r.gasBill = sum(r.gasSupply, r.gasDelivery);
    r.elecRateSupply = div(r.elecSupply, r.kwh);
    r.gasRateSupply = div(r.gasSupply, r.therms);
    r.elecRateAllIn = div(r.elecBill, r.kwh);
    r.gasRateAllIn = div(r.gasBill, r.therms);

    // Weather-normalized usage intensity (issue #5). Electric heating+cooling
    // tracks both HDD and CDD, so we divide kWh by total degree-days (HDD+CDD);
    // gas is heating-only, so therms divide by HDD alone. Pure division, null
    // when the denominator is 0 or either operand is missing.
    //   kwhPerDegreeDay = kwh / (hdd + cdd)
    //   thermsPerHdd    = therms / hdd
    const totalDD = sum(r.hdd, r.cdd);
    r.kwhPerDegreeDay = div(r.kwh, totalDD);
    r.thermsPerHdd = div(r.therms, r.hdd);
  }

  return [...months.values()].sort((a, b) => a.ym - b.ym);
}

// Year-over-year weather-normalized comparison (issue #47). Answers "did I
// actually use less, or was it just milder?" by separating the weather effect
// from a genuine intensity (behaviour) change.
//
// For one fuel, aggregate each period to a single intensity = total usage /
// total degree-days (the same kwh/(hdd+cdd) for electric, therms/hdd for gas
// that series.ts computes per row, but summed over the whole period so the
// ratio is properly usage-weighted):
//   electric degree-days  D = hdd + cdd   (heats AND cools)
//   gas degree-days       D = hdd         (heating only)
//   intensity             I = U / D
// Usage is exactly U = I × D, so the raw usage change decomposes with NO
// residual into a weather term (degree-days changed) and an intensity term
// (behaviour changed), holding the OTHER factor fixed:
//   Ua − Ub = Ia·Da − Ib·Db
//           = Ib·(Da − Db)   ← weather-explained (prior intensity, DD change)
//           + (Ia − Ib)·Da   ← normalized/intensity (DD held at this year)
// The two terms sum back to the raw delta exactly. The intensity term is the
// honest "did I use less" answer; the weather term is what milder/colder
// weather alone would have done.
//
// Cost is reported on a NORMALIZED basis so the dollar story is honest about
// rate vs usage drivers: both periods are priced at the SAME current all-in
// rate and at THIS year's degree-days, so the cost delta reflects ONLY the
// intensity change, not rate inflation or a milder winter:
//   normCost(period) = I(period) × Da × currentRate
// currentRate is the caller's trailing-12 all-in $/unit (currentCharges-sourced,
// NEVER totalDueAmount). Null cost when no rate is supplied.
//
// Percent fields are fractions (0.06 = +6%); null when the prior-year base is
// 0/missing so the UI can show "—" instead of a divide-by-zero.

export type YoyFuel = 'elec' | 'gas';

export interface YoyFuelResult {
  fuel: YoyFuel;
  // Aggregated totals for each period (A = recent, B = prior year).
  usageA: number;
  usageB: number;
  ddA: number;
  ddB: number;
  intensityA: number; // usageA / ddA
  intensityB: number; // usageB / ddB
  // Raw usage change.
  rawUsageDelta: number; // usageA − usageB (absolute, in kWh / therms)
  rawUsagePct: number | null; // (usageA − usageB) / usageB
  // Degree-day (weather) change.
  ddPct: number | null; // (ddA − ddB) / ddB
  // Additive decomposition of rawUsageDelta (the two sum to it exactly).
  weatherExplainedDelta: number; // Ib·(Da − Db)
  intensityDelta: number; // (Ia − Ib)·Da
  // Weather-normalized intensity change — the "did I actually use less" answer.
  normalizedPct: number | null; // (Ia − Ib) / Ib
  // Honest dollar view: both periods priced at the current rate and this year's
  // degree-days, so the delta is intensity-driven only. Null without a rate.
  rate: number | null; // current all-in $/unit used for normCost
  normCostA: number | null; // Ia × ddA × rate
  normCostB: number | null; // Ib × ddA × rate
  normCostDelta: number | null; // normCostA − normCostB
}

export interface YoyResult {
  elec: YoyFuelResult | null;
  gas: YoyFuelResult | null;
}

const FUEL_KEYS = {
  elec: { use: 'kwh', hdd: true, cdd: true } as const,
  gas: { use: 'therms', hdd: true, cdd: false } as const,
};

// Sum a fuel's usage and degree-days over a set of rows, requiring BOTH usage
// and the degree-day denominator present on a row for it to count (so intensity
// is comparable across the two periods). Returns null when nothing is usable.
function aggregateFuel(rows: MonthRow[], fuel: YoyFuel): { usage: number; dd: number } | null {
  const k = FUEL_KEYS[fuel];
  let usage = 0;
  let dd = 0;
  let n = 0;
  for (const r of rows) {
    const u = r[k.use] as number | null;
    const ddRow = (k.cdd ? sum(r.hdd, r.cdd) : r.hdd) ?? null;
    if (u == null || ddRow == null || ddRow <= 0) continue;
    usage += u;
    dd += ddRow;
    n += 1;
  }
  return n > 0 && dd > 0 ? { usage, dd } : null;
}

const pct = (a: number, b: number): number | null => (b > 0 ? (a - b) / b : null);

// Compare two periods (A = recent, B = prior year) on weather-normalized usage
// for one fuel. `rate` is the current all-in $/unit for the normalized cost view
// (currentCharges-sourced); pass null to skip the cost figures. Returns null
// when either period has no usable usage+degree-day data for the fuel.
function compareFuelYoY(
  periodA: MonthRow[],
  periodB: MonthRow[],
  fuel: YoyFuel,
  rate: number | null
): YoyFuelResult | null {
  const a = aggregateFuel(periodA, fuel);
  const b = aggregateFuel(periodB, fuel);
  if (!a || !b) return null;

  const intensityA = a.usage / a.dd;
  const intensityB = b.usage / b.dd;
  const rawUsageDelta = a.usage - b.usage;
  // Additive decomposition (see header): weather term at prior intensity, plus
  // intensity term at this year's degree-days. They sum to rawUsageDelta.
  const weatherExplainedDelta = intensityB * (a.dd - b.dd);
  const intensityDelta = (intensityA - intensityB) * a.dd;

  const r = rate != null && rate > 0 ? rate : null;
  const normCostA = r != null ? intensityA * a.dd * r : null;
  const normCostB = r != null ? intensityB * a.dd * r : null;

  return {
    fuel,
    usageA: a.usage,
    usageB: b.usage,
    ddA: a.dd,
    ddB: b.dd,
    intensityA,
    intensityB,
    rawUsageDelta,
    rawUsagePct: pct(a.usage, b.usage),
    ddPct: pct(a.dd, b.dd),
    weatherExplainedDelta,
    intensityDelta,
    normalizedPct: pct(intensityA, intensityB),
    rate: r,
    normCostA,
    normCostB,
    normCostDelta: normCostA != null && normCostB != null ? normCostA - normCostB : null,
  };
}

// Year-over-year weather-normalized comparison for both fuels (issue #47).
// periodA = the recent window (default trailing 12 months), periodB = the prior
// year's window. The caller slices the series into the two windows and supplies
// the current all-in rate per fuel (trailing12AllIn, currentCharges-sourced);
// the arithmetic here is pure so it's hand-calculable in tests.
export function compareYoY(
  periodA: MonthRow[],
  periodB: MonthRow[],
  rates?: { elec?: number | null; gas?: number | null }
): YoyResult {
  return {
    elec: compareFuelYoY(periodA, periodB, 'elec', rates?.elec ?? null),
    gas: compareFuelYoY(periodA, periodB, 'gas', rates?.gas ?? null),
  };
}

// Latest-month vs same-calendar-month-a-year-ago weather-normalized comparison
// (issue #47, the always-visible top-strip card). Picks the most recent row that
// carries usage as period A, then matches the SAME calendar month one year
// earlier (ym − 100, e.g. 202503 → 202403) as period B and runs the pure
// compareYoY on the two single-month windows. Rates are the currentCharges-sourced
// trailing-12 all-in (same basis the headline rate cards use), so the normalized
// cost figure is honest. Returns null when there's no usage at all or no
// prior-year row to match against; per-fuel nulls (a fuel with no prior-year
// match) fall out of compareYoY so the card shows "—" for that fuel. PURE.
export function latestVsYearAgo(rows: MonthRow[]): YoyResult | null {
  const withUsage = rows.filter((r) => r.kwh != null || r.therms != null);
  if (withUsage.length === 0) return null;
  const latest = withUsage[withUsage.length - 1];
  const priorYm = latest.ym - 100; // same calendar month, one year earlier
  const prior = rows.find((r) => r.ym === priorYm);
  if (!prior) return null;
  return compareYoY([latest], [prior], {
    elec: trailing12AllIn(rows, 'elec'),
    gas: trailing12AllIn(rows, 'gas'),
  });
}

// Effective all-in $/unit over the most recent 12 months that have data:
// total (supply + delivery) cost divided by total usage.
export function trailing12AllIn(rows: MonthRow[], fuel: 'elec' | 'gas'): number | null {
  const billKey: 'elecBill' | 'gasBill' = fuel === 'elec' ? 'elecBill' : 'gasBill';
  const useKey: 'kwh' | 'therms' = fuel === 'elec' ? 'kwh' : 'therms';
  const withData = rows.filter((r) => r[billKey] != null && r[useKey] != null && (r[useKey] as number) > 0);
  const last = withData.slice(-12);
  let cost = 0;
  let use = 0;
  for (const r of last) {
    cost += r[billKey] as number;
    use += r[useKey] as number;
  }
  return use > 0 ? cost / use : null;
}
