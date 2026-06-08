// Carbon-footprint estimate from energy usage (issue #49). PURE — no DB/React —
// so the math is hand-calculable and unit-tested. This is a LOCATION-BASED
// estimate: it multiplies usage by published average emission factors; it does
// not reflect a specific green/renewable supply plan. The grid factor is
// overridable (see gridEmissionFactor AppSetting) for users on a green plan.
import type { MonthRow } from './chartSpec';

// Natural gas combustion factor.
//   5.3 kg CO2e per therm.
// Source: EPA, "Emission Factors for Greenhouse Gas Inventories" (Table 1,
// Natural Gas: 0.0053 metric tons CO2 / therm = 5.3 kg CO2 / therm).
// https://www.epa.gov/climateleadership/ghg-emission-factors-hub
export const GAS_KG_CO2E_PER_THERM = 5.3;

// Electricity grid factor, by EPA eGRID subregion, in kg CO2e per kWh.
// eGRID reports the total output emission rate in lb CO2e/MWh; converted here:
//   kg/kWh = (lb/MWh) × 0.453592 / 1000.
// NYUP (Upstate NY): eGRID2022 total output CO2e rate ≈ 288.4 lb CO2e/MWh
//   → 288.4 × 0.453592 / 1000 = 0.1308 kg CO2e/kWh.
// Source: EPA eGRID2022 (released Jan 2024), Subregion Output Emission Rates.
// https://www.epa.gov/egrid
export const EGRID_KG_CO2E_PER_KWH: Record<string, number> = {
  NYUP: 0.1308,
};

// Map an Account.region value to its eGRID subregion. This account's region is
// NIAGARA_MOHAWK (National Grid Upstate NY → eGRID subregion NYUP).
export const REGION_TO_EGRID_SUBREGION: Record<string, string> = {
  NIAGARA_MOHAWK: 'NYUP',
};

// Fallback grid factor when the region/subregion is unknown and no override is
// set: the U.S. national average. EPA eGRID2022 national total output rate
// ≈ 800.5 lb CO2e/MWh → 0.3631 kg CO2e/kWh. Used only as a last resort so a
// brand-new/unmapped account still shows a plausible estimate.
export const US_AVG_KG_CO2E_PER_KWH = 0.3631;

export interface EmissionFactors {
  // kg CO2e per kWh of electricity (location-based grid factor).
  elecKgPerKwh: number;
  // kg CO2e per therm of natural gas.
  gasKgPerTherm: number;
}

// Resolve the electricity grid factor (kg CO2e/kWh) for an account. An explicit
// AppSetting override always wins (a user on a green plan can set their own);
// otherwise we look up the region's eGRID subregion factor, falling back to the
// U.S. national average for an unknown region. `override` is the raw string from
// the AppSetting (gridEmissionFactor); a non-finite/≤0 value is ignored.
export function resolveGridFactor(
  region: string | null | undefined,
  override?: string | null
): number {
  const o = Number.parseFloat(override ?? '');
  if (Number.isFinite(o) && o > 0) return o;
  const subregion = region ? REGION_TO_EGRID_SUBREGION[region] : undefined;
  const byRegion = subregion ? EGRID_KG_CO2E_PER_KWH[subregion] : undefined;
  return byRegion ?? US_AVG_KG_CO2E_PER_KWH;
}

// Build the factor pair for an account from its region + optional override.
export function resolveEmissionFactors(
  region: string | null | undefined,
  gridOverride?: string | null
): EmissionFactors {
  return {
    elecKgPerKwh: resolveGridFactor(region, gridOverride),
    gasKgPerTherm: GAS_KG_CO2E_PER_THERM,
  };
}

// Annotate each row with its estimated CO2e (kg), per fuel and combined. PURE:
// returns NEW rows (does not mutate). A fuel's CO2e is null when its usage is
// missing; the combined total is the sum of whichever fuels are present (null
// only when both are missing). No cost numbers are touched.
//   co2eElec  = kwh    × elecKgPerKwh
//   co2eGas   = therms × gasKgPerTherm
//   co2eTotal = co2eElec + co2eGas
export function estimateEmissions(rows: MonthRow[], factors: EmissionFactors): MonthRow[] {
  return rows.map((r) => {
    const co2eElec = r.kwh != null ? r.kwh * factors.elecKgPerKwh : null;
    const co2eGas = r.therms != null ? r.therms * factors.gasKgPerTherm : null;
    const co2eTotal =
      co2eElec == null && co2eGas == null ? null : (co2eElec ?? 0) + (co2eGas ?? 0);
    return { ...r, co2eElec, co2eGas, co2eTotal };
  });
}

// Trailing-12 CO2e (kg), summed over the most recent 12 months that have a
// combined estimate, broken out per fuel + combined plus friendly equivalences.
// PURE. Equivalence factors (EPA "Greenhouse Gas Equivalencies Calculator"):
//   - gasoline: 8.887 kg CO2e burned per gallon → gallons = kg / 8.887.
//   - carbon sequestered by one urban tree seedling grown for 10 years ≈ 60 kg
//     CO2e per tree → "tree-years" = kg / (60 / 10) = kg / 6.
// https://www.epa.gov/energy/greenhouse-gases-equivalencies-calculator-calculations-and-references
const KG_CO2E_PER_GALLON_GASOLINE = 8.887;
const KG_CO2E_SEQUESTERED_PER_TREE_YEAR = 6.0; // 60 kg over a 10-year seedling

export interface EmissionsSummary {
  elecKg: number;
  gasKg: number;
  totalKg: number;
  // Friendly equivalences for the combined trailing-12 total.
  gallonsGasoline: number;
  treeYears: number;
}

export function trailing12Emissions(rows: MonthRow[]): EmissionsSummary | null {
  const withData = rows.filter((r) => r.co2eTotal != null);
  const last = withData.slice(-12);
  if (last.length === 0) return null;
  let elecKg = 0;
  let gasKg = 0;
  for (const r of last) {
    elecKg += r.co2eElec ?? 0;
    gasKg += r.co2eGas ?? 0;
  }
  const totalKg = elecKg + gasKg;
  return {
    elecKg,
    gasKg,
    totalKg,
    gallonsGasoline: totalKg / KG_CO2E_PER_GALLON_GASOLINE,
    treeYears: totalKg / KG_CO2E_SEQUESTERED_PER_TREE_YEAR,
  };
}
