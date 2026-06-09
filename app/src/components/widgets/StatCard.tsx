'use client';

// Shared stat-card renderers (Phase A, issue #93; compact-stat-cards iteration).
// These turn the PURE selector output from lib/widgets/statSpec.ts into the card
// markup: a COMPACT body of the (brief) title (+ its ⓘ) and the headline value
// only. The old sub/detail line moved into the ⓘ tooltip; the padding is tight
// (`!px-1.5 !py-2` — the horizontal axis trimmed a hair from p-2 so a w=1 narrow
// tile has room for its full headline, e.g. "~$192.24"), and the title + value
// `truncate` so a narrow tile ellipsizes rather than overflowing —
// `overflow-hidden` on the card is the hard backstop. The visual-uniformity pass
// then made every card a flex column (`justify-between`) at ONE headline size
// (`.stat-card .stat`, globals.css) and ONE height (cardFit.ts).

import type {
  BudgetStatModel,
  StatCardModel,
  StatTooltip,
  YoyStatModel,
} from '@/lib/widgets/statSpec';
import type { ToolsTab } from '../ToolsModal';

// The ⓘ tooltip span, byte-identical to the old inline markup. `accent` only
// switches the focus-ring color (amber on the estimate card, emerald on
// carbon), matching what the two simple tooltip cards used. `stop` propagation
// is needed on the budget card's ⓘ (it sits inside a clickable card) — passed
// through so that card's render keeps the old onClick stopPropagation.
function InfoDot({ tooltip, ring, stop }: { tooltip: string; ring: string; stop?: boolean }) {
  return (
    <span
      tabIndex={0}
      role="img"
      aria-label={tooltip}
      title={tooltip}
      onClick={stop ? (e) => e.stopPropagation() : undefined}
      className={`inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-600/70 text-[10px] font-semibold text-slate-400 transition hover:border-slate-400 hover:text-slate-200 focus:outline-none focus:ring-1 ${ring}`}
    >
      i
    </span>
  );
}

const tooltipRing = (accent: StatTooltip['accent']) =>
  accent === 'emerald' ? 'focus:ring-emerald-500/60' : 'focus:ring-amber-500/60';

// The headline value markup, shared by the static + flickable simple cards.
function StatValue({ value }: { value: StatCardModel['value'] }) {
  return (
    // The headline renders at the single uniform size set by `.stat-card .stat`
    // (globals.css); `truncate` is the overflow backstop only — it never engages at
    // the default widths (verified headlessly).
    <div className="stat truncate">
      {typeof value === 'string' ? (
        value
      ) : (
        <>
          {value.lead}
          {/* The unit is a smaller trailing suffix (rate $/kWh|/therm, carbon kg).
              11px (down from text-sm/14px) so the longest unit ("/therm", on the
              narrow w=1 gas-rate tile) still fits without truncating the headline —
              verified headlessly: .stat scrollWidth ≤ clientWidth on every card,
              including gas rate in both avg + current modes. */}
          <span className="text-[11px] text-slate-500">{value.unit}</span>
        </>
      )}
    </div>
  );
}

// SIMPLE card: the 4 fixed + Est-next + Carbon. COMPACT body — just the (brief)
// title (+ its ⓘ) and the headline value; the old sub/detail line moved into the
// tooltip (the compact-stat-cards iteration). When the model carries a `flick`
// affordance (the rate cards), the card becomes a clickable button that toggles its
// headline mode (12-mo avg ↔ current) via `onFlick`; otherwise it's a plain card.
// The card is `relative` to anchor the ⓘ ring, exactly as the old estimate / carbon
// blocks were.
export function StatCard({ model, onFlick }: { model: StatCardModel; onFlick?: () => void }) {
  const flickable = !!model.flick && !!onFlick;
  // h-full so the card fills its placed grid cell (Phase E, #73). A flex column that
  // DISTRIBUTES the title + headline across the card's full height (`justify-between`)
  // so the compact card reads as filled — the visual-uniformity pass.
  // `overflow-hidden` clips it to its tile so content can never spill out (issue #73
  // content-fit). Compact `!px-1.5 !py-2` padding. A flickable card adds the same
  // clickable affordances the bespoke cards use (cursor/hover/focus ring +
  // role=button + Enter/Space).
  const base =
    'stat-card card relative flex h-full flex-col justify-between overflow-hidden !px-1.5 !py-2';
  const clickable =
    ' cursor-pointer transition hover:border-slate-600 hover:bg-slate-800/60 focus:outline-none focus:ring-1 focus:ring-amber-500/60';
  return (
    <div
      className={flickable ? base + clickable : base}
      {...(flickable
        ? { role: 'button', tabIndex: 0, onClick: onFlick, onKeyDown: activate(onFlick!) }
        : {})}
    >
      <div className="card-title flex items-center gap-1 text-xs">
        {/* `truncate` so a too-long title ellipsizes rather than overflowing a
            narrow (w=1) tile — title + headline must never clip (issue #73). */}
        <span className="min-w-0 truncate">{model.title}</span>
        {/* The ⓘ sits inside a clickable (flickable) card, so its onClick must stop
            propagation or reading the tooltip would also flick the mode. */}
        <InfoDot tooltip={model.tooltip.text} ring={tooltipRing(model.tooltip.accent)} stop={flickable} />
        {/* Flick affordance: which mode is showing + a tiny ⇄, so the toggle is
            discoverable. Pushed to the title row's right edge; presentation-only. */}
        {model.flick ? (
          <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 text-[10px] text-slate-500">
            <span aria-hidden>⇄</span>
            <span>{model.flick.label}</span>
          </span>
        ) : null}
      </div>
      <StatValue value={model.value} />
    </div>
  );
}

// Shared keyboard handler for every clickable card (the two bespoke cards + the
// flickable rate cards): Enter/Space activate, matching the role=button cards.
const activate = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

// vs-last-year (normalized) card (issue #47). Clickable → Compare tab. The
// per-fuel deltas + their emerald/rose/slate class come pre-computed from the
// pure selector; here we only lay out the "Elec +2% · Gas −5%" markup.
export function YoyStatCard({ model, openTools }: { model: YoyStatModel; openTools: (tab: ToolsTab) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openTools('compare')}
      onKeyDown={activate(() => openTools('compare'))}
      className="stat-card card relative flex h-full cursor-pointer flex-col justify-between overflow-hidden !px-1.5 !py-2 transition hover:border-slate-600 hover:bg-slate-800/60 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
    >
      <div className="card-title flex items-center gap-1 text-xs">
        <span className="min-w-0 truncate">vs last year</span>
        <InfoDot tooltip={model.tooltip} ring="focus:ring-amber-500/60" />
      </div>
      {/* Compact deltas only; the "weather-adjusted vs last year · click to compare"
          detail moved into the ⓘ tooltip. Headline renders at the single uniform
          `.stat-card .stat` size. CHANGE 1 (even strip): the yoy card is now an EVEN
          1/8-of-strip width (was 2/12), so the fuel labels are COMPACTED to single
          letters ("E −19% · G −3%") and the inter-fuel gap tightened so the two
          deltas fit the even width at the uniform font without truncating — the
          operator's "compact the text to fit, don't shrink only its font / widen
          only this card". The full "Elec/Gas" wording lives in the ⓘ + Compare tab. */}
      <div className="stat flex items-baseline gap-1.5 truncate">
        {model.elec ? (
          <span>
            <span className="text-sm text-amber-400" title="Electricity">E</span>{' '}
            <span className={model.elec.cls}>{model.elec.pct}</span>
          </span>
        ) : null}
        {model.gas ? (
          <span>
            <span className="text-sm text-sky-400" title="Gas">G</span>{' '}
            <span className={model.gas.cls}>{model.gas.pct}</span>
          </span>
        ) : null}
      </div>
    </div>
  );
}

// Budget / annual-spend target (issue #46 redesign). Clickable → Budget tab.
// Headline + progress bar; all geometry comes from the pure selector.
export function BudgetStatCard({ model, openTools }: { model: BudgetStatModel; openTools: (tab: ToolsTab) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => openTools('budget')}
      onKeyDown={activate(() => openTools('budget'))}
      className="stat-card stat-card-budget card relative flex h-full cursor-pointer flex-col justify-between overflow-hidden !px-1.5 !py-2 transition hover:border-slate-600 hover:bg-slate-800/60 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
    >
      {/* Title + headline grouped at the top; the progress bar is pushed to the
          bottom by the column's `justify-between` so the budget card fills the SAME
          shared height as every other strip card (the bar is only ~6px and fits
          within the uniform height — no extra row). */}
      <div className="card-title flex items-center gap-1 text-xs">
        <span className="min-w-0 truncate">Budget {model.fromY}</span>
        <InfoDot tooltip={model.tooltip} ring="focus:ring-amber-500/60" stop />
      </div>
      <div className="stat truncate">
        ~{model.projected}
        {/* The " / target" tail is secondary (the bar's tick + the ⓘ also carry the
            target) — it's hidden by a container query on a too-narrow tile so the
            projected headline number stays whole instead of truncating (globals.css
            `.budget-target`). */}
        <span className="budget-target text-sm text-slate-500"> / {model.target}</span>
      </div>
      {/* Progress bar: spent solid, projected-remaining lighter, with a target
          tick. Overflows into a rose tint when over budget. The "over by $X · click
          for breakdown" status line moved into the ⓘ tooltip (compact iteration). */}
      <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div className="absolute inset-y-0 left-0 flex">
          <div className={model.over ? 'bg-rose-500/80' : 'bg-amber-400'} style={{ width: `${model.spentPct}%` }} />
          <div className={model.over ? 'bg-rose-400/40' : 'bg-amber-400/35'} style={{ width: `${model.remPct}%` }} />
        </div>
        <div className="absolute inset-y-0 w-px bg-slate-300/80" style={{ left: `${model.targetPct}%` }} />
      </div>
    </div>
  );
}
