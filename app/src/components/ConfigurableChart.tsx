'use client';

import { useState } from 'react';
import {
  Area,
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
import { chartCaps, type ChartSpec, type MonthRow, type SeriesDef } from '@/lib/chartSpec';
import { usePrefs, type ChartConfig } from '@/lib/prefs';
import { Modal } from './Modal';

const tooltipStyle = { backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: 12, fontSize: 12 } as const;
const axisStyle = { stroke: '#475569', fontSize: 11 } as const;

function yProps(scale: 'linear' | 'log') {
  return scale === 'log' ? { scale: 'log' as const, domain: ['auto', 'auto'] as [string, string], allowDataOverflow: true } : {};
}

function ChartBody({ spec, config, rows, height }: { spec: ChartSpec; config: ChartConfig; rows: MonthRow[]; height: number | string }) {
  const caps = chartCaps(spec);
  const data = rows.filter(spec.filter);
  const visible = spec.series.filter((s) => !config.hidden.includes(s.key));
  const hasRight = caps.hasRight && visible.some((s) => s.axis === 'right');
  const stackId = config.stacked ? 'stack' : undefined;

  const renderSeries = (s: SeriesDef) => {
    if (s.role === 'line') {
      return (
        <Line key={s.key} yAxisId={s.axis} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2}
          strokeDasharray={s.dash ? '4 3' : undefined} dot={false} connectNulls />
      );
    }
    if (config.type === 'line') {
      return <Line key={s.key} yAxisId={s.axis} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} connectNulls />;
    }
    if (config.type === 'area') {
      return <Area key={s.key} yAxisId={s.axis} dataKey={s.key} name={s.label} stroke={s.color} fill={s.color} fillOpacity={0.45} stackId={stackId} />;
    }
    return <Bar key={s.key} yAxisId={s.axis} dataKey={s.key} name={s.label} fill={s.color} stackId={stackId} radius={[2, 2, 0, 0]} />;
  };

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#1e293b" vertical={false} />
          <XAxis dataKey="label" {...axisStyle} minTickGap={24} />
          <YAxis yAxisId="left" {...axisStyle} {...yProps(config.leftScale)}
            tickFormatter={spec.leftFmt ? (v) => spec.leftFmt!(Number(v)) : undefined} />
          {hasRight && (
            <YAxis yAxisId="right" orientation="right" {...axisStyle} {...yProps(config.rightScale)}
              tickFormatter={spec.rightFmt ? (v) => spec.rightFmt!(Number(v)) : undefined} />
          )}
          <Tooltip contentStyle={tooltipStyle} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {visible.map(renderSeries)}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
      {options.map((o) => (
        <button key={o} onClick={() => onChange(o)}
          className={`px-2.5 py-1 text-xs capitalize transition ${value === o ? 'bg-amber-500 text-slate-950' : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'}`}>
          {o}
        </button>
      ))}
    </div>
  );
}

export function ChartConfigMenu({ spec, config, onChange }: { spec: ChartSpec; config: ChartConfig; onChange: (c: Partial<ChartConfig>) => void }) {
  const caps = chartCaps(spec);
  return (
    <div className="space-y-3 text-sm">
      <div>
        <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Series</div>
        {spec.series.map((s) => {
          const shown = !config.hidden.includes(s.key);
          return (
            <label key={s.key} className="flex cursor-pointer items-center gap-2 py-0.5 text-slate-200">
              <input type="checkbox" checked={shown}
                onChange={(e) => onChange({ hidden: e.target.checked ? config.hidden.filter((k) => k !== s.key) : [...config.hidden, s.key] })} />
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: s.color }} />
              {s.label}
            </label>
          );
        })}
      </div>
      {caps.canType && (
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Chart type</div>
          <Segmented value={config.type} options={['bar', 'line', 'area'] as const} onChange={(t) => onChange({ type: t })} />
        </div>
      )}
      {caps.canStack && config.type !== 'line' && (
        <label className="flex cursor-pointer items-center gap-2 text-slate-200">
          <input type="checkbox" checked={config.stacked} onChange={(e) => onChange({ stacked: e.target.checked })} /> Stacked
        </label>
      )}
      <div className="flex flex-wrap gap-4">
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Left axis</div>
          <Segmented value={config.leftScale} options={['linear', 'log'] as const} onChange={(v) => onChange({ leftScale: v })} />
        </div>
        {caps.hasRight && (
          <div>
            <div className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Right axis</div>
            <Segmented value={config.rightScale} options={['linear', 'log'] as const} onChange={(v) => onChange({ rightScale: v })} />
          </div>
        )}
      </div>
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick}
      className="rounded-lg border border-slate-700/70 bg-slate-800/40 p-1.5 text-slate-300 transition hover:bg-slate-700 hover:text-white">
      {children}
    </button>
  );
}

const GearIcon = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
const ExpandIcon = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
);
const CloseIcon = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

// `fill` makes the chart fit the cockpit "fit" density (issue #2): the chart body
// gets an EXPLICIT, definite height at every breakpoint so Recharts'
// ResponsiveContainer (height="100%") always measures a non-zero box.
//
// We deliberately do NOT rely on a flex/`1fr`/`height:100%` chain reaching the
// ResponsiveContainer — that chain never resolves to a definite pixel height, so
// Recharts measured 0 and drew an empty chart (the regression we're fixing).
// Instead a wrapper carries a concrete height:
//   • <1280 (single col / 2-col, page scrolls): fixed `h-[16rem]` → 256px plots.
//   • ≥1280 "fit"  (no page scroll): a 100dvh-derived height. The main view now
//     PAGINATES the visible charts up to four at a time in a 2×2 grid (issue #38),
//     so the chart region has just TWO rows and each body is ≈ (100dvh − chrome)/2
//     — roughly double the old three-row height, so each chart is comfortably tall
//     on a laptop (~720–800px viewport) instead of squashed.
// `height` is the fixed height for the classic, non-fill layout (comfortable
// density and <xl both go through that path with a definite px height already).
//
// The classes apply to a wrapper the chart body fills at 100%, so charts stay
// declarative — we only change the box they draw into.
// The subtracted constant C = total non-plot chrome at ≥xl fit (page padding +
// header + control strip + the now-DENSER stat strip + the page-nav bar + all gaps
// + the 2 chart cards' own padding/headers), so (100dvh − C) is the height left
// for the two chart PLOT rows and each body = (100dvh − C)/2. With this form the
// page's total height is exactly 100dvh − C + chrome, so NO page scroll requires
// C ≥ real chrome. The denser stat cards reclaim ~1.5rem versus v0.18.0 but the
// new page-nav bar (~2.5rem incl. its gap) costs about that back, so the measured
// compact-fit chrome grows by the page-nav bar (~38px) and its gap and shrinks by
// the denser stat strip (~24px), netting ≈+1.4rem over v0.18.0's 21rem; we use
// 22.5rem (23rem at 2xl for the slightly larger type) so the two chart rows + the
// pager never clip. Plot heights with two rows: ≈216px at 768, ≈232px at 800,
// ≈280px at 896, ≈324px at 1080 — readable, growing with the viewport, and never
// scrolling at laptop sizes (1366×768, 1280×800). Two rows can't overflow because
// total = (100dvh − C) + chrome ≤ 100dvh.
const FILL_BODY_CLASSES =
  'h-[16rem] xl:h-[calc((100dvh-22.5rem)/2)] 2xl:h-[calc((100dvh-23rem)/2)]';

export function ConfigurableChart({
  spec,
  rows,
  fill = false,
  height = 288,
  config: configProp,
  onConfigChange,
}: {
  spec: ChartSpec;
  rows: MonthRow[];
  fill?: boolean;
  height?: number;
  // Phase D (#96): the dashboard now sources a chart's config from the SERVER
  // layout and supplies it (plus a write-back) here, so the in-chart Customize
  // popover persists to the server. When omitted (e.g. the demo gallery), we fall
  // back to the localStorage prefs config + prefs.updateChart, as before — so
  // this component renders byte-identically whichever side owns the config.
  config?: ChartConfig;
  onConfigChange?: (c: Partial<ChartConfig>) => void;
}) {
  const { prefs, updateChart } = usePrefs();
  const config = configProp ?? prefs.charts[spec.id];
  const [menu, setMenu] = useState(false);
  const [expand, setExpand] = useState(false);
  if (!config) return null;
  const onChange = (c: Partial<ChartConfig>) => (onConfigChange ?? ((cc) => updateChart(spec.id, cc)))(c);

  return (
    <div className={`card relative ${fill ? 'flex flex-col !p-2.5' : ''}`}>
      <div className={`flex shrink-0 items-start justify-between ${fill ? 'mb-1' : 'mb-2'}`}>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-100">{spec.title}</h3>
          {spec.subtitle && !fill && <p className="truncate text-xs text-slate-400">{spec.subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Discoverable "Customize" affordance (issue #24) — a labelled gear, not a bare icon. */}
          <button
            title="Customize this chart"
            onClick={() => setMenu((v) => !v)}
            className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition ${
              menu
                ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                : 'border-slate-700/70 bg-slate-800/40 text-slate-300 hover:bg-slate-700 hover:text-white'
            }`}
          >
            {GearIcon}
            <span className="hidden sm:inline">Customize</span>
          </button>
          <IconButton title="Expand" onClick={() => setExpand(true)}>{ExpandIcon}</IconButton>
        </div>
      </div>

      {menu && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
          <div className="absolute right-4 top-14 z-20 max-h-[70vh] w-64 overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
            <ChartConfigMenu spec={spec} config={config} onChange={onChange} />
          </div>
        </>
      )}

      {fill ? (
        // Explicit definite height (see FILL_BODY_CLASSES) — NOT a flex/100% chain —
        // so ResponsiveContainer always measures a non-zero box.
        <div className={FILL_BODY_CLASSES}>
          <ChartBody spec={spec} config={config} rows={rows} height="100%" />
        </div>
      ) : (
        <ChartBody spec={spec} config={config} rows={rows} height={height} />
      )}

      <Modal open={expand} onClose={() => setExpand(false)}>
        <div className="mb-3 flex shrink-0 items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-100">{spec.title}</h3>
            {spec.subtitle && <p className="text-xs text-slate-400">{spec.subtitle}</p>}
          </div>
          <IconButton title="Close" onClick={() => setExpand(false)}>{CloseIcon}</IconButton>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_260px]">
          <ChartBody spec={spec} config={config} rows={rows} height="80vh" />
          <div className="overflow-auto rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <ChartConfigMenu spec={spec} config={config} onChange={onChange} />
          </div>
        </div>
      </Modal>
    </div>
  );
}
