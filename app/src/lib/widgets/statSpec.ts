// Declarative spec for each dashboard stat card (Phase A of the widget
// re-architecture, issue #93). The hardcoded ~190 lines of stat-card JSX that
// used to live in Dashboard.tsx are decomposed here into PURE descriptors: a
// stable id, an isVisible predicate (mirroring the old per-card guards), and a
// value-SELECTOR that returns exactly what the card shows. NO React / DOM lives
// in this module — the markup/classes are applied by the shared StatCard
// renderer and the bespoke stat-widget render fns — so every selector here is
// hand-calculable in a unit test, the same discipline the chart specs and the
// series math already follow.
//
// Two shapes, because two cards are genuinely bespoke:
//   • SIMPLE cards (the 4 fixed + Est-next + Carbon) fit one declarative shape
//     (title / main stat / sub line / optional ⓘ tooltip) → `select()` returns a
//     StatCardModel the shared <StatCard> renders.
//   • BESPOKE cards (Budget progress bar; vs-last-year dual deltas) don't fit the
//     simple shape, so their StatSpec carries `kind:'budget'|'yoy'` and the
//     registry routes them to dedicated render fns. Their selectors are still
//     PURE (they return the numbers + class tokens the render fn lays out), so
//     the arithmetic/coloring stays testable here too.

import type { Overview } from '@/components/useDashboardData';
import type { MonthRow } from '@/lib/chartSpec';
import type { RateCardMode } from '@/lib/prefs';
import { dateLabel, estimateTooltip, num, rate, signedPct, usd } from '@/lib/format';

// The exact inputs the stat cards read today. Computed in Dashboard.tsx (the
// trailing12AllIn calls + the lastRow find stay there, pure as they already
// are) and handed to the selectors as one bag so a selector is a pure function
// of `StatData` alone.
export interface StatData {
  ov: Overview | null;
  elecAllIn: number | null;
  gasAllIn: number | null;
  lastRow: MonthRow | undefined;
  currencyDecimals: number;
  // Which rate the elec/gas rate cards show (compact-stat-cards iteration): the
  // trailing-12-mo average all-in rate ('avg', the default) or the latest month's
  // all-in rate ('current'). Flicked per-browser by clicking the card; threaded in
  // here (like currencyDecimals) so the rate SELECTORS stay pure functions of
  // StatData. Display-only — it just PICKS between two values already in the bag
  // (elecAllIn/gasAllIn vs lastRow.elecRateAllIn/gasRateAllIn); no number's source
  // or meaning changes.
  rateCardMode: RateCardMode;
}

// One ⓘ tooltip on a simple card: the text (used for both aria-label + title)
// plus the focus-ring accent so each card keeps its existing tint (amber for the
// estimate, emerald for carbon).
export interface StatTooltip {
  text: string;
  accent: 'amber' | 'emerald';
}

// The shape the shared <StatCard> renders for a SIMPLE card. The compact card body
// is just the (brief) title + the headline value — the old sub/detail line moved
// into the ⓘ tooltip (the compact-stat-cards iteration), so a card needs only its
// title + headline of height. Every simple card now carries a `tooltip` (no info is
// lost — it's relocated). `value` is either a plain string or { lead, unit } when
// the card shows a smaller trailing unit span (e.g. "/kWh", " kg") — the renderer
// applies the `text-sm text-slate-500` unit styling.
export interface StatCardModel {
  title: string;
  // The main stat. Either a plain string, or { lead, unit } when the card shows
  // a smaller trailing unit span (rate + carbon cards) — the renderer applies
  // the `text-sm text-slate-500` unit styling.
  value: string | { lead: string; unit: string };
  tooltip: StatTooltip;
  // Optional FLICK affordance (compact-stat-cards iteration): the rate cards toggle
  // their headline between the trailing-12-mo average and the current rate. When
  // present, the card renders a small clickable label (e.g. "12-mo avg" / "current")
  // and the renderer wires the click/Enter/Space to toggle the rateCardMode pref.
  // PURE selectors only emit the LABEL string here (which mode is showing); the
  // toggle callback is supplied by the renderer/host, not the selector.
  flick?: { label: string };
}

// vs-last-year selector output (issue #47). Pure: the two per-fuel normalized
// deltas (already formatted to a signed-% string) plus the emerald/rose/slate
// class token the old yoyDeltaClass produced. The render fn lays out the
// "Elec +2% · Gas −5%" markup and wires the click→Compare.
export interface YoyStatModel {
  elec: { pct: string; cls: string } | null;
  gas: { pct: string; cls: string } | null;
  tooltip: string;
}

// Budget selector output (issue #46). Pure: every number/percent/label the
// progress-bar card lays out, including the bar geometry and status tint, so the
// render fn is a thin lay-out-only component.
export interface BudgetStatModel {
  fromY: number;
  projected: string; // usd(projected, 0)
  target: string; // usd(target, 0)
  statusLabel: string; // "over by $X" / "under by $X" / "on track"
  statusColor: string; // rose / emerald / slate token for the sub line
  // Progress-bar geometry (percent widths) + whether we're over budget (drives
  // the bar's rose vs amber tint), exactly as the old inline IIFE computed.
  over: boolean;
  spentPct: number;
  remPct: number;
  targetPct: number;
  tooltip: string; // the verbose ⓘ disclaimer
}

// Green/red tint for a normalized YoY delta: LOWER usage than last year is
// BETTER (emerald), higher is WORSE (rose), ~flat or null is neutral (slate). A
// tiny epsilon around 0 counts as flat. Matches the budget card's emerald/rose
// tokens and the Compare tool's normalized-cost coloring. Presentation only —
// PURE, lifted verbatim from Dashboard.tsx so it stays unit-testable.
export const yoyDeltaClass = (pct: number | null | undefined): string =>
  pct == null || Math.abs(pct) < 0.005
    ? 'text-slate-200'
    : pct < 0
      ? 'text-emerald-300'
      : 'text-rose-300';

// The vs-last-year card self-hides unless at least one fuel matched a prior-year
// month (the old showYoyCard guard). PURE helper shared by isVisible + the
// selector so they can't drift.
const yoyFuels = (ov: Overview | null) => {
  const c = ov?.latestYoy ?? null;
  return c ? [c.elec, c.gas].filter((r) => r != null) : [];
};

// Human label for each rate-card mode — shown as the card's flick affordance and
// woven into the ⓘ tooltip so the two modes are discoverable.
export const RATE_MODE_LABEL: Record<RateCardMode, string> = {
  avg: 'avg',
  current: 'now',
};

// PURE rate-card model builder shared by elecRate + gasRate. Picks the headline
// value by mode (trailing-12-mo average vs the latest month's all-in rate — both
// already in StatData, this only SELECTS one; no number changes meaning), formats
// it at `dp` decimals so it fits a w=1 tile, and folds BOTH modes' values + the
// supply-part detail into the ⓘ tooltip. Emits the flick label so the renderer can
// show the affordance and wire the toggle. Hand-calc unit-tested.
function rateCard(o: {
  title: string;
  unit: string;
  dp: number;
  avg: number | null;
  current: number | null;
  supply: number | null;
  fuel: string;
  mode: RateCardMode;
}): StatCardModel {
  const shown = o.mode === 'current' ? o.current : o.avg;
  return {
    title: o.title,
    value: { lead: rate(shown, o.dp), unit: o.unit },
    flick: { label: RATE_MODE_LABEL[o.mode] },
    tooltip: {
      text: `Full all-in ${o.fuel} price (supply + delivery). Showing the ${
        o.mode === 'current' ? 'CURRENT (latest month)' : '12-MONTH AVERAGE'
      } rate — click the card to flick between them. 12-mo average ${rate(o.avg, o.dp)}${o.unit}; current ${rate(
        o.current,
        o.dp
      )}${o.unit}. The supply part of your latest bill is ${rate(o.supply, o.dp)}${o.unit}.`,
      accent: 'amber',
    },
  };
}

// Discriminated StatSpec. `kind:'simple'` carries the value-selector → a
// StatCardModel; the bespoke kinds carry their own pure selector. Every spec has
// a stable id (its registry key) and an isVisible predicate mirroring today's
// guard. Selectors assume isVisible has already passed (the dashboard filters
// first), matching the old JSX which only rendered a card when its guard held.
export type StatSpec =
  | {
      id: string;
      kind: 'simple';
      isVisible: (d: StatData) => boolean;
      select: (d: StatData) => StatCardModel;
    }
  | {
      id: string;
      kind: 'yoy';
      isVisible: (d: StatData) => boolean;
      select: (d: StatData) => YoyStatModel;
    }
  | {
      id: string;
      kind: 'budget';
      isVisible: (d: StatData) => boolean;
      select: (d: StatData) => BudgetStatModel;
    };

// The 8 cards, in the exact order they rendered in Dashboard.tsx: 4 fixed, then
// the optional est-next, carbon, vs-last-year and budget cards.
export const STAT_SPECS: StatSpec[] = [
  {
    id: 'latestBill',
    kind: 'simple',
    isVisible: () => true,
    // Compact card: title + the amount only; the statement date moved to the ⓘ.
    select: ({ ov, currencyDecimals: dp }) => ({
      title: 'Latest bill',
      value: usd(ov?.latestBill?.totalDueAmount, dp),
      tooltip: { text: `Amount due on your latest statement, dated ${dateLabel(ov?.latestBill?.statementDate)}.`, accent: 'amber' },
    }),
  },
  {
    id: 'lifetimeSpend',
    kind: 'simple',
    isVisible: () => true,
    // "across N bills" moved to the ⓘ.
    select: ({ ov }) => ({
      title: 'Lifetime',
      value: usd(ov?.lifetimeSpend, 0),
      tooltip: { text: `Total spent across all ${num(ov?.billCount)} bills on record.`, accent: 'amber' },
    }),
  },
  {
    id: 'elecRate',
    // Electricity all-in rate. Flicks between the trailing-12-mo average (default)
    // and the current (latest-month) all-in rate; both already live in StatData, the
    // mode just PICKS which the headline shows. 2-dp ($0.22/kWh) so it fits w=1; the
    // supply-part detail + the inactive mode's value live in the ⓘ tooltip.
    kind: 'simple',
    isVisible: () => true,
    select: ({ elecAllIn, lastRow, rateCardMode }) =>
      rateCard({
        // Brief title ("Elec", not "Elec rate") so the w=1 tile's title row also fits
        // the flick affordance (⇄ + mode) without truncating; the $/kWh unit + the ⓘ
        // ("Full all-in electricity price") keep it unambiguous it's a rate.
        title: 'Elec',
        unit: '/kWh',
        dp: 2,
        avg: elecAllIn,
        current: lastRow?.elecRateAllIn ?? null,
        supply: lastRow?.elecRateSupply ?? null,
        fuel: 'electricity',
        mode: rateCardMode,
      }),
  },
  {
    id: 'gasRate',
    // Gas all-in rate. Same flick (12-mo avg ↔ current); 2-dp $/therm so it fits w=1.
    kind: 'simple',
    isVisible: () => true,
    select: ({ gasAllIn, lastRow, rateCardMode }) =>
      rateCard({
        // Brief title ("Gas", not "Gas rate") — same w=1 title-row fit reasoning as
        // the elec card; the $/therm unit + the ⓘ disambiguate it as a rate.
        title: 'Gas',
        unit: '/therm',
        dp: 2,
        avg: gasAllIn,
        current: lastRow?.gasRateAllIn ?? null,
        supply: lastRow?.gasRateSupply ?? null,
        fuel: 'gas',
        mode: rateCardMode,
      }),
  },
  {
    // Compact estimate card (issue #38): "Est. next", "~$X"; the low–high range +
    // the verbose basis + disclaimer all live behind the ⓘ tooltip.
    id: 'nextBillEstimate',
    kind: 'simple',
    isVisible: ({ ov }) => !!ov?.nextBillEstimate,
    select: ({ ov, currencyDecimals: dp }) => {
      const e = ov!.nextBillEstimate!;
      return {
        title: 'Est. next',
        value: `~${usd(e.point, dp)}`,
        tooltip: {
          text: `Likely range ${usd(e.low, dp)}–${usd(e.high, dp)}. ${estimateTooltip(e.basis)}`,
          accent: 'amber',
        },
      };
    },
  },
  {
    // Carbon-footprint estimate (issue #49): trailing-12 combined CO2e in kg. The
    // friendly equivalences (gal gas / tree-yrs) + the location-based-ESTIMATE
    // caveat live behind the ⓘ tooltip. Never a cost number.
    id: 'emissions',
    kind: 'simple',
    isVisible: ({ ov }) => !!ov?.emissions,
    select: ({ ov }) => {
      const e = ov!.emissions!;
      return {
        title: 'Carbon',
        value: { lead: `~${num(Math.round(e.totalKg))}`, unit: ' kg' },
        tooltip: {
          text: `~${num(Math.round(e.totalKg))} kg CO₂e over the last 12 months — roughly ${num(Math.round(e.gallonsGasoline))} gal of gasoline, or ${num(Math.round(e.treeYears))} tree-years to offset. An estimate of the carbon emissions from your energy use, based on your electricity and gas and a regional grid average. It reflects the typical mix of power in your area, not your specific plan. You can set your own electricity factor in Settings if you're on a green plan.`,
          accent: 'emerald',
        },
      };
    },
  },
  {
    // vs-last-year (normalized) card (issue #47). Self-hides when no fuel has a
    // prior-year match; clickable → Compare tab (wired by the render fn).
    id: 'yoy',
    kind: 'yoy',
    isVisible: ({ ov }) => yoyFuels(ov).length > 0,
    select: ({ ov }) => {
      const c = ov!.latestYoy!;
      const fuel = (r: typeof c.elec) =>
        r ? { pct: signedPct(r.normalizedPct), cls: yoyDeltaClass(r.normalizedPct) } : null;
      return {
        elec: fuel(c.elec),
        gas: fuel(c.gas),
        tooltip:
          'How your energy use this month compares to the same month a year ago, after accounting for how hot or cold it was. This tells you whether you actually used more or less — not just whether it was a warmer or colder month. Open the Compare tool for the full breakdown and other date ranges. Not a real charge.',
      };
    },
  },
  {
    // Budget / annual-spend target (issue #46 redesign): the merged card. All
    // math is server-side (ov.budget); this only lays out the headline + bar.
    id: 'budget',
    kind: 'budget',
    isVisible: ({ ov }) => !!ov?.budget,
    select: ({ ov }) => {
      const b = ov!.budget!;
      const { spent, projected, projectedLow, projectedHigh, target, delta, status, window } = b;
      const statusColor =
        status === 'over' ? 'text-rose-300' : status === 'under' ? 'text-emerald-300' : 'text-slate-200';
      const statusLabel =
        status === 'over'
          ? `over by ${usd(Math.abs(delta), 0)}`
          : status === 'under'
            ? `under by ${usd(Math.abs(delta), 0)}`
            : 'on track';
      // Progress bar: spent (solid) + projected-remaining (lighter), as a
      // fraction of max(target, projected) so an over-budget projection still
      // fills the bar and overflows visibly into the rose tint.
      const denom = Math.max(target, projected, 1);
      const spentPct = Math.min(100, (spent / denom) * 100);
      const remPct = Math.min(100 - spentPct, (Math.max(0, projected - spent) / denom) * 100);
      const targetPct = Math.min(100, (target / denom) * 100);
      const fromY = Math.floor(window.fromYm / 100);
      return {
        fromY,
        projected: usd(projected, 0),
        target: usd(target, 0),
        statusLabel,
        statusColor,
        over: status === 'over',
        spentPct,
        remPct,
        targetPct,
        tooltip: `Projected ${usd(projected, 0)} vs your ${usd(target, 0)} target for ${fromY} — ${statusLabel}. You've spent ${usd(spent, 0)} so far, and we expect about ${usd(projected, 0)} by year's end (range ${usd(projectedLow, 0)}–${usd(projectedHigh, 0)}). "Spent" adds up what you were actually charged for energy on this year's bills; the rest of the year is estimated. On-track vs. over budget accounts for winter naturally costing more. Click for the month-by-month breakdown, or set your target in Settings. Not a real charge.`,
      };
    },
  },
];

export const STAT_SPEC_BY_ID: Record<string, StatSpec> = Object.fromEntries(
  STAT_SPECS.map((s) => [s.id, s])
);

// The set of stat ids the registry must register — used by the registry's
// completeness check and the unit tests so a new card can't be added without
// being wired through the registry.
export const STAT_IDS = STAT_SPECS.map((s) => s.id);
