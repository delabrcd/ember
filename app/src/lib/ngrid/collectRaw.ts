// Typed shapes for the raw GraphQL payloads the scraper intercepts off the portal's
// own SPA traffic (collect.ts), plus the shared response-URL matcher. These mirror
// the EXISTING `Raw*`-interface + explicit-narrow idiom in interval.ts: the captured
// JSON is an untyped boundary, so each `Raw*` interface describes ONLY the fields the
// parser reads, every field optional, and the parser narrows with `as` at the edge.
//
// This is pure shape-typing — it changes no parse output. The values handed to
// persist()/`/api/verify` (bill currentCharges, usage quantity, …) are byte-identical
// to the prior `any`-typed reads; we only attach names to the same property accesses.

// Matches a captured gql RESPONSE url, e.g. `/api/billingaccount-cu-uwp-gql`.
// Was inlined as `/\/api\/[a-z-]+-gql/` in collect.ts (onDiscovery + onResponse) and
// intervalPull.ts's light capture — exported once so the three copies can't drift.
// (Distinct from the Playwright ROUTE glob `**/api/**-gql` used for page.route().)
export const GQL_URL_RE = /\/api\/[a-z-]+-gql/;

// The captured `data` envelope keyed by gql field name. Only the keys collect()
// reads are described; each is optional (a given response carries a subset).
export interface RawGqlData {
  Bills?: unknown;
  energyUsages?: unknown;
  energyUsageCosts?: unknown;
  energyUsageBillAmounts?: unknown;
  weather?: unknown;
  billingAccount?: unknown;
  user?: unknown;
}

// The full gql response body (`{ data: {…} }`). `data` may be absent on errors.
export interface RawGqlResponse {
  data?: RawGqlData | null;
}

// A bill node from the `Bills` payload — only the fields collect()'s mapper reads.
export interface RawBillNode {
  statementDate?: string;
  billDuration?: { fromDate?: string; toDate?: string } | null;
  totalDueAmount?: unknown;
  status?: string;
  energyUsages?: unknown; // narrowed via asArray → RawBillEnergyUsage[]
}

// A nested energy-usage node inside a bill (only `usageType` is read).
export interface RawBillEnergyUsage {
  usageType?: string;
}

// A usage node from the `energyUsages` payload.
export interface RawEnergyUsageNode {
  usageType?: string;
  usageYearMonth?: unknown;
  dateFrom?: string;
  dateTo?: string;
  usage?: unknown;
}

// A weather node from the `weather` payload.
export interface RawWeatherNode {
  applicableMonthYear?: string;
  region?: string;
  averageTemperature?: unknown;
  measureUnit?: string;
}

// A fuel-type entry inside `billingAccount.fuelTypes` — either a bare string or a
// `{ type }` object (collect() accepts both).
export type RawFuelType = string | { type?: string } | null | undefined;

// The captured `billingAccount` payload. Only the fields collect() reads are named;
// `meter` is consumed by interval.ts's `extractAmiMeters` (which narrows it itself),
// so it stays `unknown` here.
export interface RawBillingAccount {
  serviceAddress?: unknown; // string | { serviceAddressCompressed?; compressed? } | …
  fuelTypes?: unknown; // narrowed via Array.isArray → RawFuelType[]
  region?: string;
  premiseNumber?: unknown;
  customerNumber?: unknown;
  meter?: unknown;
}
