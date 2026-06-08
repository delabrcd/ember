'use client';

// Shared stat-card renderers (Phase A, issue #93). These turn the PURE
// selector output from lib/widgets/statSpec.ts into the EXACT markup the old
// hardcoded Dashboard.tsx cards produced — same `.card !p-3`, `.card-title
// text-xs`, `.stat text-2xl`, `.sub mt-0.5 text-[11px] text-slate-500`, and the
// ⓘ span. Phase A is a render-identical refactor, so the class strings here are
// copied verbatim from the deleted JSX; do not "tidy" them.

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

// SIMPLE card: the 4 fixed + Est-next + Carbon. Renders title (+ optional ⓘ),
// the stat value (with the optional smaller unit span), and the sub line. When
// a tooltip is present the card gets `relative` exactly as the old estimate /
// carbon blocks did.
export function StatCard({ model }: { model: StatCardModel }) {
  return (
    <div className={`card !p-3${model.tooltip ? ' relative' : ''}`}>
      <div className={`card-title text-xs${model.tooltip ? ' flex items-center gap-1' : ''}`}>
        {model.title}
        {model.tooltip ? <InfoDot tooltip={model.tooltip.text} ring={tooltipRing(model.tooltip.accent)} /> : null}
      </div>
      <div className="stat text-2xl">
        {typeof model.value === 'string' ? (
          model.value
        ) : (
          <>
            {model.value.lead}
            <span className="text-sm text-slate-500">{model.value.unit}</span>
          </>
        )}
      </div>
      <div className="sub mt-0.5 text-[11px] text-slate-500">{model.sub}</div>
    </div>
  );
}

// Shared keyboard handler for the two clickable bespoke cards: Enter/Space
// activate, matching the old role=button cards.
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
      className="card relative cursor-pointer !p-3 transition hover:border-slate-600 hover:bg-slate-800/60 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
    >
      <div className="card-title flex items-center gap-1 text-xs">
        vs last year
        <InfoDot tooltip={model.tooltip} ring="focus:ring-amber-500/60" />
      </div>
      <div className="stat flex items-baseline gap-2 text-2xl">
        {model.elec ? (
          <span>
            <span className="text-sm text-amber-400">Elec</span> <span className={model.elec.cls}>{model.elec.pct}</span>
          </span>
        ) : null}
        {model.gas ? (
          <span>
            <span className="text-sm text-sky-400">Gas</span> <span className={model.gas.cls}>{model.gas.pct}</span>
          </span>
        ) : null}
      </div>
      <div className="sub mt-0.5 text-[11px] text-slate-500">weather-adjusted vs last year · click to compare</div>
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
      className="card relative cursor-pointer !p-3 transition hover:border-slate-600 hover:bg-slate-800/60 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
    >
      <div className="card-title flex items-center gap-1 text-xs">
        Budget {model.fromY}
        <InfoDot tooltip={model.tooltip} ring="focus:ring-amber-500/60" stop />
      </div>
      <div className="stat text-2xl">
        ~{model.projected}
        <span className="text-sm text-slate-500"> / {model.target}</span>
      </div>
      {/* Progress bar: spent solid, projected-remaining lighter, with a target
          tick. Overflows into a rose tint when over budget. */}
      <div className="relative mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
        <div className="absolute inset-y-0 left-0 flex">
          <div className={model.over ? 'bg-rose-500/80' : 'bg-amber-400'} style={{ width: `${model.spentPct}%` }} />
          <div className={model.over ? 'bg-rose-400/40' : 'bg-amber-400/35'} style={{ width: `${model.remPct}%` }} />
        </div>
        <div className="absolute inset-y-0 w-px bg-slate-300/80" style={{ left: `${model.targetPct}%` }} />
      </div>
      <div className={`sub mt-0.5 text-[11px] ${model.statusColor}`}>{model.statusLabel} · click for breakdown</div>
    </div>
  );
}
