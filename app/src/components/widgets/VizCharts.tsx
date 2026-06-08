'use client';

// The Phase C renderer components (issue #95; RFC §3.2 Decision 3): one
// DECLARATIVE renderer per new vizType — scatter, heatmap, profile. Each takes a
// spec (its typed encoding) + the host-resolved rows, runs the PURE aggregator
// from lib/viz/aggregate.ts, and draws the result. There is NO per-feature
// bespoke chart here: a future widget reuses these by registering a spec, exactly
// like the timeseries charts reuse ConfigurableChart.
//
// • scatter / profile → Recharts (already a dependency).
// • heatmap → a DEPENDENCY-FREE inline-SVG grid. A day×hour grid of <rect>s with
//   a data-driven color scale is straightforward and keeps the bundle lean, so we
//   did NOT pull in visx (the one pre-approved optional dep) — see the report.
//
// Theme: the dark slate/amber/sky tokens used across the dashboard
// (#0f172a card, #f59e0b amber elec, #38bdf8 sky gas, slate axes).

import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import type { HeatmapVizSpec, ProfileVizSpec, ScatterVizSpec } from '@/lib/chartSpec';
import {
  colorScale01,
  dayHourHeatmap,
  heatmapRowLabels,
  hourOfDayProfile,
  scatterPoints,
} from '@/lib/viz/aggregate';

const tooltipStyle = {
  backgroundColor: '#0f172a',
  border: '1px solid #1e293b',
  borderRadius: 12,
  fontSize: 12,
} as const;
const axisStyle = { stroke: '#475569', fontSize: 11 } as const;

const AMBER = '#f59e0b';
const SKY = '#38bdf8';

// A wrapper giving each viz a definite-height box so Recharts'
// ResponsiveContainer always measures a non-zero plot (the same reason
// ConfigurableChart wraps its body). `height` is a px number.
function VizBox({ height, children }: { height: number; children: React.ReactNode }) {
  return (
    <div style={{ height }} className="w-full">
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SCATTER
// ---------------------------------------------------------------------------
export function ScatterViz<Row>({
  spec,
  rows,
  height = 288,
}: {
  spec: ScatterVizSpec<Row>;
  rows: readonly Row[];
  height?: number;
}) {
  const points = scatterPoints(rows, spec.encoding);
  const color = spec.encoding.color ?? AMBER;
  const xName = spec.encoding.xLabel ?? String(spec.encoding.x);
  const yName = spec.encoding.yLabel ?? String(spec.encoding.y);
  return (
    <VizBox height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 10, right: 16, left: 0, bottom: 16 }}>
          <CartesianGrid stroke="#1e293b" />
          <XAxis
            type="number"
            dataKey="x"
            name={xName}
            {...axisStyle}
            domain={['auto', 'auto']}
            label={{ value: xName, position: 'insideBottom', offset: -8, fill: '#64748b', fontSize: 11 }}
          />
          <YAxis
            type="number"
            dataKey="y"
            name={yName}
            {...axisStyle}
            domain={['auto', 'auto']}
            label={{ value: yName, angle: -90, position: 'insideLeft', fill: '#64748b', fontSize: 11 }}
          />
          {/* Fixed dot size — z is constant; ZAxis present so the tooltip is clean. */}
          <ZAxis range={[42, 42]} />
          <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: '#334155' }} />
          <Scatter data={points} fill={color} fillOpacity={0.8} />
        </ScatterChart>
      </ResponsiveContainer>
    </VizBox>
  );
}

// ---------------------------------------------------------------------------
// PROFILE — hour-of-day load profile, optional ±1σ band.
// ---------------------------------------------------------------------------
export function ProfileViz<Row>({
  spec,
  rows,
  height = 288,
}: {
  spec: ProfileVizSpec<Row>;
  rows: readonly Row[];
  height?: number;
}) {
  const buckets = hourOfDayProfile(rows, spec.encoding);
  const valueName = spec.encoding.valueLabel ?? String(spec.encoding.value);
  const bucketName = spec.encoding.bucketLabel ?? String(spec.encoding.bucket);
  const showBand = spec.encoding.band ?? false;
  // Recharts can't stack-fill "between two lines" directly; we draw the band as a
  // base (transparent) area up to `lower` then a visible area of thickness
  // (upper − lower). `bandBase`/`bandSpan` are precomputed per bucket.
  const data = buckets.map((b) => ({
    bucket: b.bucket,
    value: b.value,
    bandBase: b.lower,
    bandSpan: Math.max(0, b.upper - b.lower),
  }));
  return (
    <VizBox height={height}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 16, left: 0, bottom: 16 }}>
          <CartesianGrid stroke="#1e293b" vertical={false} />
          <XAxis
            dataKey="bucket"
            {...axisStyle}
            label={{ value: bucketName, position: 'insideBottom', offset: -8, fill: '#64748b', fontSize: 11 }}
          />
          <YAxis {...axisStyle} domain={[0, 'auto']} />
          <Tooltip contentStyle={tooltipStyle} />
          {showBand && (
            // Invisible base lifts the visible band to `lower`; the stacked span
            // is the ±1σ thickness, drawn faint so the mean line reads on top.
            <>
              <Area type="monotone" dataKey="bandBase" stackId="band" stroke="none" fill="none" isAnimationActive={false} />
              <Area
                type="monotone"
                dataKey="bandSpan"
                stackId="band"
                name="±1σ"
                stroke="none"
                fill={AMBER}
                fillOpacity={0.15}
                isAnimationActive={false}
              />
            </>
          )}
          <Line type="monotone" dataKey="value" name={valueName} stroke={AMBER} strokeWidth={2} dot={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </VizBox>
  );
}

// ---------------------------------------------------------------------------
// HEATMAP — dependency-free inline SVG grid (day rows × hour columns).
// Color scale: a single-hue ramp from cold slate to amber, driven by the
// aggregator's min/max via colorScale01. A null cell (no data in that bin) is
// drawn as the bare track color so the grid stays rectangular.
// ---------------------------------------------------------------------------

// Map a 0..1 intensity to an `rgb()` on a slate→amber ramp. Endpoints are the
// dashboard's empty-track slate (#1e293b ≈ 30,41,59) and amber (#f59e0b ≈
// 245,158,11); we lerp each channel. Pure + simple so the color choice is
// auditable (the reviewer ask) — no external color library.
function rampColor(t: number): string {
  const c0 = [30, 41, 59];
  const c1 = [245, 158, 11];
  const r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
  const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
  const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
  return `rgb(${r}, ${g}, ${b})`;
}

export function HeatmapViz<Row>({
  spec,
  rows,
  height = 288,
}: {
  spec: HeatmapVizSpec<Row>;
  rows: readonly Row[];
  height?: number;
}) {
  const grid = dayHourHeatmap(rows, spec.encoding);
  const { xs, ys, cells, min, max } = grid;
  const valueName = spec.encoding.valueLabel ?? String(spec.encoding.value);
  // Optional per-row display labels (e.g. day index → 'Mon'), built purely from
  // the encoding's `yLabelField`. Empty when none encoded → we fall back to `y`.
  const yLabels = heatmapRowLabels(rows, spec.encoding);
  const rowLabel = (y: number): string => yLabels[y] ?? String(y);

  // SVG geometry. We reserve a left gutter for y labels and a bottom gutter for
  // x labels, then size square-ish cells to fill the remaining box width. Using
  // a viewBox + preserveAspectRatio keeps it crisp and responsive.
  const padL = 44;
  const padB = 22;
  const padT = 8;
  const padR = 8;
  const cols = Math.max(1, xs.length);
  const rowsN = Math.max(1, ys.length);
  // A fixed logical width; the SVG scales to its container. Cell size derives
  // from the grid so any grain (24 hours, or 96 fifteen-min bins later) fits.
  const cellW = 22;
  const cellH = Math.max(14, Math.min(28, Math.floor((height - padT - padB) / rowsN)));
  const w = padL + cols * cellW + padR;
  const h = padT + rowsN * cellH + padB;

  // Index cells by "x|y" so we can place them; the aggregator already emits a
  // full rectangular grid in row-major order, but a lookup keeps placement
  // independent of emission order.
  const byKey = new Map(cells.map((c) => [`${c.x}|${c.y}`, c] as const));

  return (
    <VizBox height={height}>
      <div className="flex h-full w-full items-center">
        <svg
          viewBox={`0 0 ${w} ${h}`}
          width="100%"
          height="100%"
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={`${valueName} heatmap`}
        >
          {ys.map((y, yi) =>
            xs.map((x, xi) => {
              const cell = byKey.get(`${x}|${y}`);
              const v = cell?.value ?? null;
              const fill = v == null ? '#0f172a' : rampColor(colorScale01(v, min, max));
              return (
                <rect
                  key={`${x}|${y}`}
                  x={padL + xi * cellW + 1}
                  y={padT + yi * cellH + 1}
                  width={cellW - 2}
                  height={cellH - 2}
                  rx={2}
                  fill={fill}
                >
                  <title>
                    {`${valueName} — ${rowLabel(y)}, x=${x}: ${
                      v == null ? 'no data' : v.toFixed(2)
                    }`}
                  </title>
                </rect>
              );
            })
          )}
          {/* y-axis labels (one per row) */}
          {ys.map((y, yi) => (
            <text
              key={`yl-${y}`}
              x={padL - 6}
              y={padT + yi * cellH + cellH / 2}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={10}
              fill="#94a3b8"
            >
              {rowLabel(y)}
            </text>
          ))}
          {/* x-axis labels — every other column to avoid crowding 24 hours */}
          {xs.map((x, xi) =>
            xi % 2 === 0 ? (
              <text
                key={`xl-${x}`}
                x={padL + xi * cellW + cellW / 2}
                y={h - 6}
                textAnchor="middle"
                fontSize={10}
                fill="#94a3b8"
              >
                {x}
              </text>
            ) : null
          )}
        </svg>
      </div>
    </VizBox>
  );
}
