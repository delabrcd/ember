'use client';

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
import { ChartShell } from './ChartShell';

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

export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: readonly T[]; onChange: (v: T) => void }) {
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

// `fill` makes the chart FILL its placed grid cell (Phase E, #73); see ChartShell
// for the full explanation of the fill vs fixed-`height` layout. ConfigurableChart
// now delegates all card chrome (header, Customize gear, settings popover, Expand
// modal) to ChartShell and supplies only its body (ChartBody) and settings
// (ChartConfigMenu).

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
  if (!config) return null;
  const onChange = (c: Partial<ChartConfig>) => (onConfigChange ?? ((cc) => updateChart(spec.id, cc)))(c);

  return (
    <ChartShell
      title={spec.title}
      subtitle={spec.subtitle}
      fill={fill}
      height={height}
      body={(h) => <ChartBody spec={spec} config={config} rows={rows} height={h} />}
      settings={<ChartConfigMenu spec={spec} config={config} onChange={onChange} />}
    />
  );
}
