'use client';

import {
  RANGE_PRESETS,
  resolveRange,
  ymToYmd,
  ymdToYm,
  type RangePref,
} from '@/lib/range';

// The dashboard's date-range picker (issue #24). Preset chips (All / YTD / 12 /
// 24 / 36 mo) plus a custom from→to month pair. It drives the charts, the bills
// list AND the export scoping through a single persisted RangePref (prefs.range).
//
// The from/to inputs always show the *resolved* bounds for the active preset, so
// switching to "Custom" pre-fills with whatever was on screen rather than going
// blank. Editing either input flips the preset to 'custom'. `allYms`/`nowYm` come
// from the live data so the inputs clamp to the real history.
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
  // The date inputs operate on the first-of-month for the resolved bounds.
  const fromYmd = ymToYmd(resolved.fromYm);
  const toYmd = ymToYmd(resolved.toYm);
  const dataMin = allYms.length ? ymToYmd(Math.min(...allYms)) : undefined;
  const dataMax = allYms.length ? ymToYmd(Math.max(...allYms)) : undefined;

  const setCustomFrom = (ymd: string) => {
    const ym = ymdToYm(ymd);
    onChange({ preset: 'custom', fromYm: ym, toYm: resolved.toYm });
  };
  const setCustomTo = (ymd: string) => {
    const ym = ymdToYm(ymd);
    onChange({ preset: 'custom', fromYm: resolved.fromYm, toYm: ym });
  };

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
      <div
        className={`inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 transition ${
          range.preset === 'custom' ? 'border-amber-500/60 bg-slate-800/60' : 'border-slate-700 bg-slate-800/30'
        }`}
      >
        <input
          type="month"
          aria-label="Range start month"
          value={fromYmd.slice(0, 7)}
          min={dataMin?.slice(0, 7)}
          max={toYmd.slice(0, 7)}
          onChange={(e) => setCustomFrom(e.target.value)}
          className="bg-transparent text-xs text-slate-200 focus:outline-none [color-scheme:dark]"
        />
        <span className="text-xs text-slate-500">→</span>
        <input
          type="month"
          aria-label="Range end month"
          value={toYmd.slice(0, 7)}
          min={fromYmd.slice(0, 7)}
          max={dataMax?.slice(0, 7)}
          onChange={(e) => setCustomTo(e.target.value)}
          className="bg-transparent text-xs text-slate-200 focus:outline-none [color-scheme:dark]"
        />
      </div>
    </div>
  );
}
