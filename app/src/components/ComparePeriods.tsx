'use client';

// Interactive "Compare periods" tool (issue #47). Lets the user pick any two
// ranges — via a preset (trailing-12, this-winter-vs-last, YTD) or two custom
// month-range pickers — and renders the full weather-normalized per-fuel
// breakdown from the pure compareYoY. This REPLACES the old density-hidden
// YoyPanel: it's always visible (both densities) so a default user can actually
// reach the YoY story.
//
// ALL period math is pure + tested: presetPair / winterSpan / ytdSpan
// (lib/comparePresets.ts) map a preset to two {fromYm,toYm} windows; filterByYm
// (lib/range.ts) slices the loaded series; compareYoY (lib/series.ts) does the
// arithmetic; trailing12AllIn supplies the currentCharges-sourced rate for the
// normalized-cost figure. This component is just wiring inputs → pure helpers →
// display, plus the lifted YoyPanel presentation.

import { useMemo, useState } from 'react';
import type { MonthRow } from '@/lib/chartSpec';
import { compareYoY, trailing12AllIn, type YoyFuelResult } from '@/lib/series';
import {
  COMPARE_PRESETS,
  presetPair,
  type ComparePreset,
  type CompareWindow,
} from '@/lib/comparePresets';
import { filterByYm, ymToLabel } from '@/lib/range';
import { MonthRangePicker } from './MonthRangePicker';
import { num, usd, signedPct, yoyVerdict } from '@/lib/format';

// Per-fuel display metadata, matching the rest of the dashboard's fuel accents
// (amber = electric, sky = gas) — lifted from the old YoyPanel.
const FUELS = [
  { key: 'elec', label: 'Electric', unit: 'kWh', accent: 'text-amber-400' },
  { key: 'gas', label: 'Gas', unit: 'therms', accent: 'text-sky-400' },
] as const;

// One fuel's raw/weather/behaviour breakdown + normalized cost (lifted from the
// old YoyPanel so the tool reads identically to what users saw before).
function FuelBreakdown({
  res,
  label,
  unit,
  accent,
  currencyDecimals,
}: {
  res: YoyFuelResult;
  label: string;
  unit: string;
  accent: string;
  currencyDecimals: number;
}) {
  return (
    <div className="border-t border-slate-800/60 pt-2 first:border-0 first:pt-0">
      <p className="text-sm text-slate-200">
        <span className={`font-semibold ${accent}`}>{yoyVerdict(res, label, unit)}</span>
      </p>
      <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px] text-slate-500">
        <span>Raw {signedPct(res.rawUsagePct)} ({num(Math.round(res.rawUsageDelta))} {unit})</span>
        <span>Weather {num(Math.round(res.weatherExplainedDelta))} {unit}</span>
        <span>Behaviour {num(Math.round(res.intensityDelta))} {unit}</span>
        {res.normCostDelta != null && (
          <span>
            Normalized cost{' '}
            <span className={res.normCostDelta < 0 ? 'text-emerald-400' : res.normCostDelta > 0 ? 'text-rose-400' : ''}>
              {res.normCostDelta < 0 ? '−' : res.normCostDelta > 0 ? '+' : ''}
              {usd(Math.abs(res.normCostDelta), currencyDecimals)}
            </span>{' '}
            at current rates
          </span>
        )}
      </div>
    </div>
  );
}

export function ComparePeriods({
  rows,
  currencyDecimals = 0,
}: {
  rows: MonthRow[];
  currencyDecimals?: number;
}) {
  const [preset, setPreset] = useState<ComparePreset>('trailing12');

  // Data span for the pickers and the preset anchor. The anchor is the latest
  // ym present, so presets line up with the newest data even if the clock is off.
  const allYms = rows.map((r) => r.ym);
  const minYm = allYms.length ? Math.min(...allYms) : null;
  const maxYm = allYms.length ? Math.max(...allYms) : null;
  const anchorYm = maxYm;

  // Custom-mode windows: default A to the most recent 12 months and B to the 12
  // before that (mirrors the trailing-12 preset) so opening "Custom…" starts from
  // a sensible, non-empty comparison rather than blank pickers.
  const trailingDefaults = anchorYm != null ? presetPair('trailing12', anchorYm) : null;
  const [customA, setCustomA] = useState<CompareWindow>(
    () => trailingDefaults?.a ?? { fromYm: minYm ?? 0, toYm: maxYm ?? 0 }
  );
  const [customB, setCustomB] = useState<CompareWindow>(
    () => trailingDefaults?.b ?? { fromYm: minYm ?? 0, toYm: maxYm ?? 0 }
  );

  // The two active windows: from the preset math, or the custom pickers. PURE
  // selection — the component never does period arithmetic itself.
  const { a, b } = useMemo<{ a: CompareWindow | null; b: CompareWindow | null }>(() => {
    if (preset === 'custom') return { a: customA, b: customB };
    const pair = anchorYm != null ? presetPair(preset, anchorYm) : null;
    return { a: pair?.a ?? null, b: pair?.b ?? null };
  }, [preset, customA, customB, anchorYm]);

  // Slice the loaded series to each window and run the pure compareYoY with the
  // currentCharges-sourced trailing-12 all-in rate per fuel.
  const result = useMemo(() => {
    if (!a || !b) return null;
    const periodA = filterByYm(rows, a);
    const periodB = filterByYm(rows, b);
    return compareYoY(periodA, periodB, {
      elec: trailing12AllIn(rows, 'elec'),
      gas: trailing12AllIn(rows, 'gas'),
    });
  }, [rows, a, b]);

  const fuelRows = FUELS.map((f) => ({ ...f, res: result?.[f.key] ?? null })).filter((f) => f.res != null);

  return (
    <div className="card !p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="card-title flex items-center gap-1 text-xs">
          Compare periods
          <span
            tabIndex={0}
            role="img"
            aria-label="Compare any two windows on weather-normalized usage. Raw usage change is split into the part explained by warmer/colder weather (degree-days) and the part that's a genuine usage change, by comparing each period's usage per degree-day. The cost figure prices the intensity change at your current all-in rate (from bill PDF current charges) — it isolates the usage story from weather and rate changes; it is not a real charge."
            title="Compare any two windows on weather-normalized usage. Raw usage change is split into the part explained by warmer/colder weather (degree-days) and the part that's a genuine usage change, by comparing each period's usage per degree-day. The cost figure prices the intensity change at your current all-in rate (from bill PDF current charges) — it isolates the usage story from weather and rate changes; it is not a real charge."
            className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-600/70 text-[10px] font-semibold text-slate-400 transition hover:border-slate-400 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
          >
            i
          </span>
        </div>
        <select
          value={preset}
          onChange={(e) => setPreset(e.target.value as ComparePreset)}
          aria-label="Comparison preset"
          className="rounded-lg border border-slate-700 bg-slate-800/50 px-2 py-1 text-xs text-slate-200 transition hover:bg-slate-700 focus:outline-none focus:ring-1 focus:ring-amber-500/70"
        >
          {COMPARE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {/* Custom mode reveals two range pickers (A = recent, B = comparison). */}
      {preset === 'custom' ? (
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-semibold uppercase tracking-wide text-amber-400">A</span>
            <MonthRangePicker
              fromYm={customA.fromYm}
              toYm={customA.toYm}
              minYm={minYm}
              maxYm={maxYm}
              active
              onChange={setCustomA}
            />
          </div>
          <span className="text-slate-500">vs</span>
          <div className="flex items-center gap-2">
            <span className="font-semibold uppercase tracking-wide text-sky-400">B</span>
            <MonthRangePicker
              fromYm={customB.fromYm}
              toYm={customB.toYm}
              minYm={minYm}
              maxYm={maxYm}
              active
              onChange={setCustomB}
            />
          </div>
        </div>
      ) : (
        // For presets, show the resolved spans so the comparison is explicit.
        a && b && (
          <p className="mt-2 text-[11px] text-slate-500">
            <span className="text-amber-300">{ymToLabel(a.fromYm)} – {ymToLabel(a.toYm)}</span>
            {' vs '}
            <span className="text-sky-300">{ymToLabel(b.fromYm)} – {ymToLabel(b.toYm)}</span>
          </p>
        )
      )}

      <div className="mt-3 space-y-3">
        {fuelRows.length === 0 ? (
          <p className="text-sm text-slate-500">
            Not enough usage + degree-day data in both windows to compare. Pick wider ranges.
          </p>
        ) : (
          fuelRows.map(({ key, label, unit, accent, res }) => (
            <FuelBreakdown
              key={key}
              res={res!}
              label={label}
              unit={unit}
              accent={accent}
              currencyDecimals={currencyDecimals}
            />
          ))
        )}
      </div>
    </div>
  );
}
