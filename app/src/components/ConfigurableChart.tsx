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

// `fill` makes the chart FILL its placed grid cell (Phase E, #73). The cell's
// height is now supplied by the react-grid-layout engine — at the lg/fit
// breakpoint it's the runtime-computed `rowHeight × h` (the no-scroll fit
// COMPUTED from the measured chrome height in WidgetLayout); at scrolling
// breakpoints it's a fixed rowHeight × h. Either way the cell already has a
// definite pixel height, so
// the chart just needs to fill it 100% top-to-bottom.
//
// To make Recharts' ResponsiveContainer (height="100%") measure a non-zero box,
// the fill card is a flex COLUMN whose body is `flex-1 min-h-0` — the cell's
// definite height flows down the flex chain to the body, which the
// ResponsiveContainer then fills. (The old constant-height wrapper is gone:
// the height comes from the grid cell, not a baked-in calc.)
//
// `height` is still the fixed pixel height for the non-fill layout (the demo
// gallery and any non-grid caller) — unchanged.

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
    <div className={`card relative ${fill ? 'flex h-full min-h-0 flex-col !p-2.5' : ''}`}>
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
        // Fill the placed grid cell: `flex-1 min-h-0` takes the remaining height
        // of the flex-column card (whose height is the cell's definite px height
        // from the RGL engine), and ChartBody draws into it at 100%. min-h-0 lets
        // the flex child actually shrink so the ResponsiveContainer measures the
        // real box instead of overflowing.
        <div className="min-h-0 flex-1">
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
