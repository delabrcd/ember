'use client';

// ESCO supply-rate what-if panel (issue #48). The biggest controllable lever on a
// National Grid bill is the SUPPLY rate — you can switch ESCO suppliers while
// DELIVERY stays with the utility — so this lets you enter a quoted fixed supply
// rate ($/kWh, $/therm) and back-tests it against your ACTUAL historical usage:
// "a $0.12/kWh fixed supply would have cost $X vs the $Y you paid; $Z saved/lost."
//
// All arithmetic lives in the pure, hand-tested whatIfSupply (lib/series.ts); this
// component only collects the two rates and renders the numbers it returns. Supply
// costs are PDF-sourced (elecSupply / gasSupply), never totalDueAmount, and the
// back-test runs over whatever rows the dashboard passes (the on-screen range).
import { useMemo, useState } from 'react';
import type { MonthRow } from '@/lib/chartSpec';
import { whatIfSupply, type WhatIfFuelResult } from '@/lib/series';
import { usd } from '@/lib/format';

// Per-fuel display metadata, matching the rest of the dashboard's accents
// (amber = electric, sky = gas) and rate units.
const FUELS = [
  { key: 'elec', label: 'Electric', unit: '$/kWh', accent: 'text-amber-400' },
  { key: 'gas', label: 'Gas', unit: '$/therm', accent: 'text-sky-400' },
] as const;

// Parse a user-typed rate into a positive number, else null (so a blank or junk
// field simply skips that fuel rather than poisoning the math).
function parseRate(s: string): number | null {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// A short "$Z saved / lost / no change" verdict from a signed delta where a
// NEGATIVE delta (hypothetical < actual) is a SAVING. dp matches the dashboard's
// currency-decimals pref.
function savingsLabel(delta: number, dp: number): { text: string; cls: string } {
  if (delta < 0) return { text: `${usd(-delta, dp)} saved`, cls: 'text-emerald-400' };
  if (delta > 0) return { text: `${usd(delta, dp)} more`, cls: 'text-rose-400' };
  return { text: 'no change', cls: 'text-slate-300' };
}

export function SupplyWhatIf({ rows, currencyDecimals = 2 }: { rows: MonthRow[]; currencyDecimals?: number }) {
  const [elecInput, setElecInput] = useState('');
  const [gasInput, setGasInput] = useState('');
  const dp = currencyDecimals;

  // The pure back-test. Re-runs only when the rows or the parsed rates change.
  const elecRate = parseRate(elecInput);
  const gasRate = parseRate(gasInput);
  const result = useMemo(
    () => whatIfSupply(rows, { elecRate, gasRate }),
    [rows, elecRate, gasRate]
  );

  const perFuel = FUELS.map((f) => ({ ...f, res: result[f.key] })).filter(
    (f): f is typeof f & { res: WhatIfFuelResult } => f.res != null
  );
  const months = perFuel.reduce((m, f) => Math.max(m, f.res.months), 0);

  return (
    <div className="card relative !p-3">
      <div className="card-title flex items-center gap-1 text-xs">
        Supply-rate what-if (switch ESCO)
        <span
          tabIndex={0}
          role="img"
          aria-label="Enter a quoted fixed ESCO supply rate. It back-tests that rate against your actual historical usage (PDF-sourced supply cost ÷ usage), holding delivery constant since it stays with the utility. The result is what you WOULD have paid for supply over the back-tested months — not a real charge or a guaranteed future price."
          title="Enter a quoted fixed ESCO supply rate. It back-tests that rate against your actual historical usage (PDF-sourced supply cost ÷ usage), holding delivery constant since it stays with the utility. The result is what you WOULD have paid for supply over the back-tested months — not a real charge or a guaranteed future price."
          className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-slate-600/70 text-[10px] font-semibold text-slate-400 transition hover:border-slate-400 hover:text-slate-200 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
        >
          i
        </span>
      </div>

      {/* Inputs: a quoted fixed supply rate per fuel. Transient (v1) — not persisted. */}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
        {FUELS.map((f) => (
          <label key={f.key} className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className={`font-medium ${f.accent}`}>{f.label}</span>
            <span className="text-slate-500">{f.unit}</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="0.001"
              placeholder={f.key === 'elec' ? '0.12' : '1.20'}
              value={f.key === 'elec' ? elecInput : gasInput}
              onChange={(e) => (f.key === 'elec' ? setElecInput : setGasInput)(e.target.value)}
              className="w-20 rounded-md border border-slate-700/70 bg-slate-800/60 px-2 py-1 text-right font-mono text-slate-100 focus:border-amber-500/60 focus:outline-none"
            />
          </label>
        ))}
      </div>

      {/* Result. Hidden until at least one valid rate produces a back-test. */}
      {perFuel.length === 0 ? (
        <p className="mt-2 text-[11px] text-slate-500">
          Enter a quoted supply rate to back-test it against your actual usage.
        </p>
      ) : (
        <div className="mt-2 space-y-2">
          {perFuel.map(({ key, label, accent, res }) => {
            const s = savingsLabel(res.delta, dp);
            return (
              <p key={key} className="text-sm text-slate-200">
                <span className={`font-semibold ${accent}`}>{label}:</span>{' '}
                {usd(res.rate, 3)} supply would have cost{' '}
                <span className="font-medium text-slate-100">{usd(res.hypothetical, dp)}</span> vs the{' '}
                <span className="font-medium text-slate-100">{usd(res.actual, dp)}</span> you paid —{' '}
                <span className={`font-semibold ${s.cls}`}>{s.text}</span>.
              </p>
            );
          })}
          {result.delta != null && perFuel.length > 1 && (
            <p className="border-t border-slate-800/60 pt-2 text-sm text-slate-200">
              <span className="font-semibold text-slate-100">Net:</span>{' '}
              <span className={`font-semibold ${savingsLabel(result.delta, dp).cls}`}>
                {savingsLabel(result.delta, dp).text}
              </span>{' '}
              over the back-tested period.
            </p>
          )}
          <p className="text-[11px] text-slate-500">
            Back-tested over {months} {months === 1 ? 'month' : 'months'} of actual usage in the selected range.
            Delivery is held constant. Not a real charge.
          </p>
        </div>
      )}
    </div>
  );
}
