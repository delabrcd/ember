// Pure aggregation + rate math, independent of the database so it can be unit
// tested with hand-calculated inputs. queries.ts feeds it DB rows; the dashboard
// uses trailing12AllIn for the headline rate cards.
import type { MonthRow } from './chartSpec';
import { ymAddMonths, ymLabel } from './ym';

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

// Supply-rate trend trailing average (issue #48). Stamps each row with the
// trailing-N-month average effective SUPPLY $/unit so a slowly creeping variable
// rate is visible on the rates chart against the raw per-month line. Usage-weighted
// (total supply cost / total usage over the window), matching trailing12AllIn's
// definition rather than a flat mean of per-month rates, so a high-usage month
// pulls the average the way it pulls the bill. Mutates rows in place (they're
// freshly built by deriveMonthlySeries); window default 6 months. A row only gets
// an average once enough prior data exists in its window — null otherwise, so the
// dashed trend line starts where it's meaningful.
export function withSupplyRateTrailing(rows: MonthRow[], window = 6): MonthRow[] {
  const fuels = [
    { supply: 'elecSupply', use: 'kwh', avg: 'elecRateSupplyAvg' },
    { supply: 'gasSupply', use: 'therms', avg: 'gasRateSupplyAvg' },
  ] as const;
  for (let i = 0; i < rows.length; i++) {
    for (const f of fuels) {
      let cost = 0;
      let use = 0;
      let n = 0;
      for (let j = Math.max(0, i - window + 1); j <= i; j++) {
        const c = rows[j][f.supply] as number | null;
        const u = rows[j][f.use] as number | null;
        if (c == null || u == null || u <= 0) continue;
        cost += c;
        use += u;
        n += 1;
      }
      rows[i][f.avg] = n > 0 && use > 0 ? cost / use : null;
    }
  }
  return rows;
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

// ---------------------------------------------------------------------------
// Budget / annual-spend target with on-track projection (issue #46)
//
// "Am I on track for my spending target?" The window defaults to the calendar
// year (the caller passes {fromYm, toYm} — calendar-year by default — so this
// pure fn never needs a clock). Three pieces:
//
//   1. SPENT so far = sum of each in-window bill's period energy charge
//      (billTotal = currentCharges — the PDF source of truth). NEVER the API
//      amount due (totalDueAmount), which can fold in a carried-over balance and
//      would double-count. This is asserted in the unit tests.
//   2. PROJECTED end-of-window total = spent + the cost of the bills still to
//      come in the window. We DON'T recompute any prediction here — the caller
//      passes in the already-computed next-bill estimate (issue #9/#67) and the
//      seasonal 12-month projection (issue #52); we just SELECT the future
//      periods that land inside the window and sum them. A future period counts
//      as "remaining" when its ym is strictly after the latest in-window bill we
//      already have AND within the window. The next-bill estimate (point + band)
//      is used for the FIRST such period; any later in-window periods come from
//      the seasonal projection. Each future period carries its own band, which
//      we combine in QUADRATURE (independent period residuals, matching how the
//      seasonal annual band is built) to band the projected total.
//   3. STATUS vs the target: 'over' / 'under' / 'on_track', with delta =
//      projected − target (positive = over budget). A small tolerance band
//      around the target (default ±2%) reads as 'on_track' so a trivially-close
//      projection isn't alarmingly flagged either way.
//
// Returns null only when there's no target set. With a target but no spend yet
// it still reports (spent 0, projected = the remaining projection). PURE — the
// projection inputs are supplied; the arithmetic is hand-calculable in tests.
// ---------------------------------------------------------------------------

export interface BudgetWindow {
  fromYm: number; // inclusive YYYYMM lower bound
  toYm: number; // inclusive YYYYMM upper bound
}

// A future bill period the projection knows about, with its confidence band.
// The caller maps the next-bill estimate and seasonal months onto this shape.
export interface BudgetFuturePeriod {
  ym: number;
  point: number;
  low: number;
  high: number;
}

export interface BudgetProjectionInput {
  // The next-bill estimate (issue #9/#67), keyed to the period it covers. Used
  // for the first remaining in-window period. Omit when there's no estimate.
  nextBill?: BudgetFuturePeriod | null;
  // The seasonal 12-month projection's per-month periods (issue #52). Supplies
  // any in-window periods beyond the next bill. Empty when none.
  seasonMonths?: BudgetFuturePeriod[];
}

export type BudgetStatus = 'over' | 'under' | 'on_track';

export interface BudgetResult {
  window: BudgetWindow;
  target: number;
  spent: number; // sum of in-window billTotal (currentCharges)
  billsCounted: number; // how many in-window bills fed `spent`
  // Remaining projection: the in-window future periods we summed, and their band.
  remaining: number; // sum of remaining-period points
  remainingLow: number; // spent + Σ low (band floored at spent)
  remainingHigh: number; // spent + Σ high
  remainingPeriods: number; // count of future periods counted
  // End-of-window projection = spent + remaining, with a quadrature band.
  projected: number;
  projectedLow: number;
  projectedHigh: number;
  delta: number; // projected − target (positive = over budget)
  status: BudgetStatus;
}

// Fraction of the target within which the projection reads as "on track" rather
// than over/under, so a projection a few dollars off a $2,800 target isn't
// alarmingly flagged. ±2% of target.
export const BUDGET_ON_TRACK_TOL = 0.02;

export function projectBudget(
  rows: MonthRow[],
  target: number | null | undefined,
  window: BudgetWindow,
  projection?: BudgetProjectionInput,
  opts?: { tolerance?: number }
): BudgetResult | null {
  if (target == null || !(target > 0) || !Number.isFinite(target)) return null;

  const inWindow = (ym: number) => ym >= window.fromYm && ym <= window.toYm;

  // Spent so far = Σ in-window billTotal (currentCharges). NEVER totalDueAmount.
  let spent = 0;
  let billsCounted = 0;
  let latestBilledYm = 0;
  for (const r of rows) {
    if (r.billTotal == null || !inWindow(r.ym)) continue;
    spent += r.billTotal;
    billsCounted += 1;
    if (r.ym > latestBilledYm) latestBilledYm = r.ym;
  }

  // Remaining in-window periods: strictly after the latest bill we already have
  // (so we never double-count a period that's both billed AND projected), inside
  // the window. The next-bill estimate covers its own period; seasonal months
  // cover the rest. De-dupe by ym (next-bill wins over a same-ym seasonal month).
  const future = new Map<number, BudgetFuturePeriod>();
  const nb = projection?.nextBill;
  if (nb && inWindow(nb.ym) && nb.ym > latestBilledYm) future.set(nb.ym, nb);
  for (const m of projection?.seasonMonths ?? []) {
    if (!inWindow(m.ym) || m.ym <= latestBilledYm || future.has(m.ym)) continue;
    future.set(m.ym, m);
  }

  const periods = [...future.values()];
  const remaining = periods.reduce((s, p) => s + p.point, 0);
  // Band: combine the per-period half-widths in quadrature (independent period
  // residuals, matching the seasonal annual band), then center on spent+remaining.
  const halfSq = periods.reduce((s, p) => s + Math.max(0, p.high - p.point) ** 2, 0);
  const half = Math.sqrt(halfSq);

  const projected = spent + remaining;
  const projectedLow = Math.max(spent, projected - half);
  const projectedHigh = projected + half;

  const delta = projected - target;
  const tol = (opts?.tolerance ?? BUDGET_ON_TRACK_TOL) * target;
  const status: BudgetStatus = delta > tol ? 'over' : delta < -tol ? 'under' : 'on_track';

  return {
    window,
    target,
    spent,
    billsCounted,
    remaining,
    remainingLow: Math.max(spent, spent + periods.reduce((s, p) => s + p.low, 0)),
    remainingHigh: spent + periods.reduce((s, p) => s + p.high, 0),
    remainingPeriods: periods.length,
    projected,
    projectedLow,
    projectedHigh,
    delta,
    status,
  };
}

// Calendar-year budget window for a given ym (YYYYMM): Jan–Dec of that ym's year.
// The default window the dashboard uses; the caller passes the current ym.
export function calendarYearWindow(ym: number): BudgetWindow {
  const year = Math.floor(ym / 100);
  return { fromYm: year * 100 + 1, toYm: year * 100 + 12 };
}

// ---------------------------------------------------------------------------
// budgetMonthly — month-by-month budget pace with a SEASONALLY-WEIGHTED expected
// share (issue #46, Budget tab).
//
// The flat "over by $X" headline is unfair month-to-month: a Northeast winter
// bill is several times a shoulder-season one, so spending $300 in January is
// NOT over budget the way spending $300 in May would be. This builds a per-month
// breakdown for the budget window where the EXPECTED pace is weighted by the
// season instead of split evenly.
//
// SEASONAL PACE WEIGHTING
//   We derive a per-calendar-month weight from the seasonal 12-month projection's
//   projected COSTS (projCost — the climatological degree-day-normals × rate
//   estimate, the same numbers the projection card/series use). The projection
//   covers exactly 12 consecutive months (one full calendar cycle) starting after
//   the latest usage row, so it carries one value per calendar month. We key it by
//   CALENDAR MONTH (ym % 100, 1..12) so even an already-billed window month gets a
//   seasonal weight from its calendar-month projection.
//     weight[m]  = projCost for calendar month m   (≥ 0)
//     share[m]   = weight[m] / Σ weight             (normalized to sum to 1)
//     expected[m]= target × share[m]
//   So winter months get a larger expected slice and summer a smaller one — the
//   pace is seasonally fair. FALLBACK: if no seasonal data is supplied (or every
//   weight is 0), every month gets a FLAT 1/N share (N = months in window).
//
// PER MONTH (one entry per calendar month in the window):
//   actual    : billed spend for that month = the row's billTotal (currentCharges,
//               the PDF source of truth — NEVER totalDueAmount), or null if the
//               month has no bill yet.
//   expected  : target × seasonal share for that month (the fair pace).
//   projected : actual when the month is already billed; otherwise the seasonal
//               projection's projCost for that calendar month (the same forward
//               estimate the headline projectBudget() rolls up). null when neither
//               an actual nor a projection exists.
//   cumActual / cumExpected / cumProjected: running totals through that month.
//               cumActual is null until the first billed month, then CARRIES the
//               last billed cumulative forward (it flattens once months are
//               unbilled rather than dropping back to null), so the actual-spend
//               line is continuous up to "today".
//   status    : the cumulative-pace verdict for that month — projected cumulative
//               vs expected cumulative, with the same ±tolerance band as
//               projectBudget (BUDGET_ON_TRACK_TOL × target). 'over'/'under'/
//               'on_track'. This is the seasonally-fair on/off-track signal.
//
// REUSE: the year-end headline (projected total, status vs target) is NOT
// recomputed here — the caller passes projectBudget()'s BudgetResult through so
// the card and tab agree. budgetMonthly is purely the per-month detail.
//
// PURE: all inputs are supplied; the arithmetic is hand-calculable in tests.
// ---------------------------------------------------------------------------

export interface BudgetMonthlyMonth {
  ym: number;
  label: string;
  share: number; // this month's normalized share of the annual (Σ share = 1)
  actual: number | null; // billed currentCharges, or null if not yet billed
  expected: number; // target × share (the seasonally-fair pace for the month)
  projected: number | null; // actual if billed, else the seasonal projection point
  cumActual: number | null; // running Σ actual through this month (null until first bill)
  cumExpected: number; // running Σ expected through this month
  cumProjected: number; // running Σ projected through this month (uses expected when no point)
  delta: number; // cumProjected − cumExpected (positive = ahead of pace = spending more)
  status: BudgetStatus; // cumulative pace verdict vs the seasonal expectation
}

export interface BudgetMonthlyResult {
  window: BudgetWindow;
  target: number;
  seasonal: boolean; // true when seasonal weights were used; false on the flat fallback
  months: BudgetMonthlyMonth[];
  // Convenience roll-ups (= the last month's cumulatives) so the tab needn't sum.
  totalActual: number; // Σ actual over billed months
  billsCounted: number; // how many months had an actual
}

// Each calendar month in [fromYm, toYm], inclusive.
function windowMonths(window: BudgetWindow): number[] {
  const out: number[] = [];
  for (let ym = window.fromYm; ym <= window.toYm; ym = ymAddMonths(ym, 1)) out.push(ym);
  return out;
}

export function budgetMonthly(
  rows: MonthRow[],
  target: number | null | undefined,
  window: BudgetWindow,
  // The seasonal 12-month projection months (issue #52): one projCost per calendar
  // month. Supplies the pace weights AND the future-month projected points. Pass
  // [] / null for the flat-share fallback.
  seasonal?: { ym: number; projCost: number }[] | null,
  opts?: { tolerance?: number }
): BudgetMonthlyResult | null {
  if (target == null || !(target > 0) || !Number.isFinite(target)) return null;

  const months = windowMonths(window);
  const n = months.length;

  // billTotal (currentCharges) per window month. NEVER totalDueAmount.
  const actualByYm = new Map<number, number>();
  for (const r of rows) {
    if (r.billTotal == null || r.ym < window.fromYm || r.ym > window.toYm) continue;
    actualByYm.set(r.ym, (actualByYm.get(r.ym) ?? 0) + r.billTotal);
  }

  // Seasonal projected cost keyed by CALENDAR MONTH (1..12). The projection spans
  // one full cycle, so each calendar month appears once.
  const projByCalMonth = new Map<number, number>();
  for (const m of seasonal ?? []) {
    const cal = m.ym % 100;
    if (m.projCost >= 0 && !projByCalMonth.has(cal)) projByCalMonth.set(cal, m.projCost);
  }

  // Per-month weight = the calendar month's seasonal projected cost. Use seasonal
  // weights only when we have a weight for EVERY window month and they sum > 0;
  // otherwise fall back to a flat 1/N share so the pace is still defined.
  const rawWeights = months.map((ym) => projByCalMonth.get(ym % 100) ?? 0);
  const weightSum = rawWeights.reduce((s, w) => s + w, 0);
  const useSeasonal =
    weightSum > 0 && rawWeights.every((w) => w > 0) && months.length > 0;
  const shares = useSeasonal ? rawWeights.map((w) => w / weightSum) : months.map(() => 1 / n);

  const tol = (opts?.tolerance ?? BUDGET_ON_TRACK_TOL) * target;

  let cumActual = 0;
  let sawActual = false;
  let cumExpected = 0;
  let cumProjected = 0;
  let totalActual = 0;
  let billsCounted = 0;

  const out: BudgetMonthlyMonth[] = months.map((ym, i) => {
    const share = shares[i];
    const expected = target * share;
    const actualRaw = actualByYm.get(ym);
    const hasActual = actualRaw != null;

    // projected: the actual if billed, else this calendar month's seasonal point
    // (the same forward estimate the headline rolls up). null when neither exists.
    const projPoint = projByCalMonth.get(ym % 100);
    const projected = hasActual ? actualRaw! : projPoint != null ? projPoint : null;

    if (hasActual) {
      cumActual += actualRaw!;
      sawActual = true;
      totalActual += actualRaw!;
      billsCounted += 1;
    }
    cumExpected += expected;
    // cumProjected accrues the projected point (actual or seasonal estimate); when a
    // future month has no projection at all it falls back to the expected pace so
    // the cumulative projection still spans the whole window.
    cumProjected += projected != null ? projected : expected;

    const delta = cumProjected - cumExpected;
    const status: BudgetStatus = delta > tol ? 'over' : delta < -tol ? 'under' : 'on_track';

    return {
      ym,
      label: ymLabel(ym),
      share,
      actual: hasActual ? actualRaw! : null,
      expected,
      projected,
      cumActual: sawActual ? cumActual : null,
      cumExpected,
      cumProjected,
      delta,
      status,
    };
  });

  return {
    window,
    target,
    seasonal: useSeasonal,
    months: out,
    totalActual,
    billsCounted,
  };
}

// ESCO supply-rate what-if back-test (issue #48). The biggest controllable lever
// on a National Grid bill is the SUPPLY rate — you can switch ESCO suppliers while
// DELIVERY stays with the utility — so this answers "what would a quoted fixed
// supply rate have cost me against my actual historical usage?".
//
// For each fuel, sum the actual PDF-sourced supply cost (elecSupply / gasSupply —
// NEVER totalDueAmount) and the actual usage (kwh / therms) over every row that
// has BOTH (so actual and hypothetical cover the same months), then price that
// same usage at the user's hypothetical fixed rate:
//   hypothetical = Σ usage × rate
//   delta        = hypothetical − actual   (negative = you'd have SAVED)
// Delivery is held constant (it doesn't change with supplier), so it never enters
// the math. A fuel with no hypothetical rate, or no usable months, comes back
// null. Pure arithmetic so it's hand-calculable in tests; the component only
// collects the two rates and renders the returned numbers.

export type WhatIfFuel = 'elec' | 'gas';

export interface WhatIfFuelResult {
  fuel: WhatIfFuel;
  rate: number; // the hypothetical fixed supply $/unit applied
  usage: number; // total actual usage over the back-tested months
  months: number; // count of months that had both supply cost and usage
  actual: number; // total actual supply cost (PDF-sourced)
  hypothetical: number; // usage × rate
  delta: number; // hypothetical − actual (negative = savings)
}

export interface WhatIfResult {
  elec: WhatIfFuelResult | null;
  gas: WhatIfFuelResult | null;
  // Combined across whichever fuels were priced (null if neither). The net delta
  // is the headline "$Z saved/lost" figure.
  actual: number | null;
  hypothetical: number | null;
  delta: number | null;
}

const WHATIF_KEYS = {
  elec: { supply: 'elecSupply', use: 'kwh' },
  gas: { supply: 'gasSupply', use: 'therms' },
} as const;

function whatIfFuel(rows: MonthRow[], fuel: WhatIfFuel, rate: number | null | undefined): WhatIfFuelResult | null {
  if (rate == null || !(rate > 0)) return null;
  const k = WHATIF_KEYS[fuel];
  let usage = 0;
  let actual = 0;
  let months = 0;
  for (const r of rows) {
    const c = r[k.supply] as number | null;
    const u = r[k.use] as number | null;
    if (c == null || u == null || u <= 0) continue;
    usage += u;
    actual += c;
    months += 1;
  }
  if (months === 0) return null;
  const hypothetical = usage * rate;
  return { fuel, rate, usage, months, actual, hypothetical, delta: hypothetical - actual };
}

// Back-test hypothetical fixed ESCO supply rates against actual historical usage
// for both fuels. `rates.elecRate` is $/kWh, `rates.gasRate` is $/therm; omit or
// pass a non-positive rate to skip a fuel. The caller slices `rows` to the window
// it wants back-tested (e.g. the on-screen range or trailing 12 months).
export function whatIfSupply(
  rows: MonthRow[],
  rates: { elecRate?: number | null; gasRate?: number | null }
): WhatIfResult {
  const elec = whatIfFuel(rows, 'elec', rates.elecRate);
  const gas = whatIfFuel(rows, 'gas', rates.gasRate);
  const parts = [elec, gas].filter((p): p is WhatIfFuelResult => p != null);
  if (parts.length === 0) return { elec, gas, actual: null, hypothetical: null, delta: null };
  const actual = parts.reduce((s, p) => s + p.actual, 0);
  const hypothetical = parts.reduce((s, p) => s + p.hypothetical, 0);
  return { elec, gas, actual, hypothetical, delta: hypothetical - actual };
}
