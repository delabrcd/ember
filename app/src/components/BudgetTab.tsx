'use client';

// Budget tab of the Tools modal (issue #46). The redesign merges the old
// always-visible Budget card and the "Proj. next 12 mo" card into ONE Budget card
// in the stat strip; clicking it opens this tab, which holds the detail that no
// longer fits on a compact card:
//   - the SEASONALLY-WEIGHTED month-by-month pace (winter is naturally heavier, so
//     on/off-track is fair month to month instead of a flat guilt number),
//   - the year-end roll-up vs the target (REUSED from the same projectBudget()
//     result the card shows, so card and tab agree), AND
//   - the 12-month projection context the proj-12 card used to surface.
//
// ALL arithmetic is in the pure, tested helper budgetMonthly() (lib/series.ts);
// this component only renders. It is given the loaded series (for actuals), the
// seasonal projection (pace weights + future points) and the BudgetResult (target
// + headline). When no target is set the parent shows a prompt instead of this.

import { useMemo } from 'react';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import Link from 'next/link';
import type { MonthRow } from '@/lib/chartSpec';
import { budgetMonthly, type BudgetResult, type BudgetStatus } from '@/lib/series';
import type { SeasonProjection } from '@/lib/prediction';
import { usd } from '@/lib/format';

// Status → token + label, matching the budget card's emerald/rose vocabulary.
const STATUS_TOKEN: Record<BudgetStatus, string> = {
  over: 'text-rose-300',
  under: 'text-emerald-300',
  on_track: 'text-slate-200',
};
const statusLabel = (s: BudgetStatus): string =>
  s === 'over' ? 'over pace' : s === 'under' ? 'under pace' : 'on pace';

export function BudgetTab({
  rows,
  budget,
  seasonProjection,
  currencyDecimals,
}: {
  rows: MonthRow[];
  // The headline numbers (target, projected year-end, status). REUSED so the card
  // and tab agree; null only when no target is set (parent shows a prompt then).
  budget: BudgetResult | null;
  // The seasonal 12-month projection: supplies the per-month pace weights and the
  // future-month projected points. null when the server has no projection.
  seasonProjection: SeasonProjection | null;
  currencyDecimals: number;
}) {
  const dp0 = 0; // budget figures read better as whole dollars
  const usd0 = (n: number | null | undefined) => usd(n, dp0);

  // Hooks run unconditionally (React rules-of-hooks). budgetMonthly returns null
  // when there's no target, which lines up with the no-budget branch below.
  const monthly = useMemo(
    () =>
      budget
        ? budgetMonthly(
            rows,
            budget.target,
            budget.window,
            seasonProjection?.months.map((m) => ({ ym: m.ym, projCost: m.projCost })) ?? null
          )
        : null,
    [rows, budget, seasonProjection]
  );

  // No target → prompt to set one (the target input lives in Settings, issue #46).
  if (!budget || !monthly) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 text-sm text-slate-300">
        <div className="mb-1 font-medium text-slate-200">No budget set</div>
        <p className="text-slate-400">
          Set an annual spending target to see a seasonally-fair month-by-month pace and a
          projected year-end total.{' '}
          <Link href="/settings" className="text-amber-400 hover:underline">
            Set a budget
          </Link>
          .
        </p>
      </div>
    );
  }

  const year = Math.floor(budget.window.fromYm / 100);
  const { spent, projected, projectedLow, projectedHigh, target, status } = budget;
  const overUnder =
    status === 'over'
      ? `over by ${usd0(Math.abs(budget.delta))}`
      : status === 'under'
        ? `under by ${usd0(Math.abs(budget.delta))}`
        : 'on track';

  // Chart data: per-month actual (or null), expected pace, and the cumulative
  // projected vs expected lines. Recharts connects nulls off by default so unbilled
  // months simply have no actual bar.
  const chartData = monthly.months.map((m) => ({
    label: m.label.slice(2), // 'YY-MM' → 'YY-MM' trimmed of century for axis density
    actual: m.actual,
    expected: Number(m.expected.toFixed(2)),
    cumProjected: Number(m.cumProjected.toFixed(2)),
    cumExpected: Number(m.cumExpected.toFixed(2)),
  }));

  return (
    <div className="space-y-4">
      {/* Headline: projected year-end vs target + seasonal-fair status. REUSES the
          projectBudget() result so it matches the stat-strip card exactly. */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div className="text-sm font-medium text-slate-200">Budget {year}</div>
          <div className={`text-sm ${STATUS_TOKEN[status]}`}>{overUnder}</div>
        </div>
        <div className="mt-1 text-2xl text-slate-100">
          ~{usd0(projected)}
          <span className="text-base text-slate-500"> / {usd0(target)}</span>
        </div>
        <div className="mt-0.5 text-[12px] text-slate-500">
          {usd0(spent)} spent so far ({monthly.billsCounted} bill
          {monthly.billsCounted === 1 ? '' : 's'}) · projected year-end range {usd0(projectedLow)}–
          {usd0(projectedHigh)}
        </div>
        <div className="mt-1 text-[11px] text-slate-500">
          Expected pace is{' '}
          {monthly.seasonal ? (
            <span className="text-slate-400">seasonally weighted</span>
          ) : (
            <span className="text-slate-400">split evenly</span>
          )}{' '}
          across the year{monthly.seasonal ? ' — winter months carry a bigger share' : ''}, so a
          heavy winter bill isn&apos;t flagged the way a heavy summer one would be. Spent uses each
          bill&apos;s actual period charges (the PDF source of truth), never the statement amount
          due. Not a real charge.
        </div>
      </div>

      {/* Projection context (absorbs the removed "Proj. next 12 mo" card). */}
      {seasonProjection && seasonProjection.months.length > 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-[12px] text-slate-400">
          <span className="text-slate-300">Next 12 months projected: </span>
          ~{usd0(seasonProjection.annual.point)} (range {usd0(seasonProjection.annual.low)}–
          {usd0(seasonProjection.annual.high)}). Climatological projection (degree-day normals ×
          current rates) — {seasonProjection.basis}. Not a forecast, not a real charge.
        </div>
      ) : null}

      {/* Actual vs expected pace per month, with cumulative lines. A tool-view
          chart (not a dashboard chartSpec) — Recharts is already in the bundle. */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-3">
        <div className="mb-2 px-1 text-xs text-slate-400">
          Actual vs expected pace per month · cumulative lines
        </div>
        <div className="h-64 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
              <XAxis dataKey="label" tick={{ fill: '#94a3b8', fontSize: 11 }} />
              <YAxis tick={{ fill: '#94a3b8', fontSize: 11 }} width={44} />
              <Tooltip
                contentStyle={{ background: '#0f172a', border: '1px solid #1e293b', borderRadius: 8, fontSize: 12 }}
                formatter={(v: number) => usd(v, currencyDecimals)}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="actual" name="Spent" fill="#f59e0b" radius={[2, 2, 0, 0]} />
              <Bar dataKey="expected" name="Expected pace" fill="#475569" radius={[2, 2, 0, 0]} />
              <Line dataKey="cumProjected" name="Cumulative (proj.)" stroke="#38bdf8" strokeWidth={2} dot={false} />
              <Line dataKey="cumExpected" name="Cumulative expected" stroke="#64748b" strokeWidth={2} strokeDasharray="4 3" dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Month-by-month table: spent · expected pace · cumulative actual ·
          cumulative expected · over/under (the seasonally-fair verdict). */}
      <div className="overflow-x-auto rounded-xl border border-slate-800">
        <table className="w-full min-w-[34rem] border-collapse text-right text-[13px]">
          <thead>
            <tr className="border-b border-slate-800 text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2 text-left font-medium">Month</th>
              <th className="px-3 py-2 font-medium">Spent</th>
              <th className="px-3 py-2 font-medium">Expected</th>
              <th className="px-3 py-2 font-medium">Cum. actual</th>
              <th className="px-3 py-2 font-medium">Cum. expected</th>
              <th className="px-3 py-2 font-medium">Pace</th>
            </tr>
          </thead>
          <tbody>
            {monthly.months.map((m) => (
              <tr key={m.ym} className="border-b border-slate-800/60 last:border-0">
                <td className="px-3 py-1.5 text-left text-slate-300">{m.label}</td>
                <td className="px-3 py-1.5 text-slate-200">
                  {m.actual != null ? usd0(m.actual) : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-3 py-1.5 text-slate-400">{usd0(m.expected)}</td>
                <td className="px-3 py-1.5 text-slate-300">
                  {m.cumActual != null ? usd0(m.cumActual) : <span className="text-slate-600">—</span>}
                </td>
                <td className="px-3 py-1.5 text-slate-400">{usd0(m.cumExpected)}</td>
                <td className={`px-3 py-1.5 ${STATUS_TOKEN[m.status]}`}>{statusLabel(m.status)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
