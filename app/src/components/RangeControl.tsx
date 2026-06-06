'use client';

import { RANGE_PRESETS, resolveRange, type RangePref } from '@/lib/range';
import { MonthRangePicker } from './MonthRangePicker';

// The dashboard's date-range picker (issue #24, visual picker in #39). Preset
// chips (All / YTD / 12 / 24 / 36 mo) plus a visual month/year range popover that
// replaces the old native <input type="month"> pair. It drives the charts, the
// bills list AND the export scoping through a single persisted RangePref
// (prefs.range).
//
// The picker always shows the *resolved* bounds for the active preset, so opening
// it on a preset pre-fills with whatever is on screen rather than going blank.
// Picking a month flips the preset to 'custom'; choosing a preset chip reflects
// straight back into the picker's displayed span. `allYms`/`nowYm` come from the
// live data so the picker clamps to the real history (months outside it are
// greyed/disabled).
export function RangeControl({
  range,
  onChange,
  allYms,
  nowYm,
}: {
  range: RangePref;
  onChange: (r: RangePref) => void;
  allYms: number[];
  nowYm: number;
}) {
  const resolved = resolveRange(range, allYms, nowYm);
  // Clamp the picker to the data's natural span (first statement → latest ym).
  const minYm = allYms.length ? Math.min(...allYms) : null;
  const maxYm = allYms.length ? Math.max(...allYms) : null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.value}
            onClick={() => onChange({ preset: p.value, fromYm: null, toYm: null })}
            className={`px-2.5 py-1 text-xs transition ${
              range.preset === p.value
                ? 'bg-amber-500 text-slate-950'
                : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>
      <MonthRangePicker
        fromYm={resolved.fromYm}
        toYm={resolved.toYm}
        minYm={minYm}
        maxYm={maxYm}
        active={range.preset === 'custom'}
        onChange={({ fromYm, toYm }) => onChange({ preset: 'custom', fromYm, toYm })}
      />
    </div>
  );
}
