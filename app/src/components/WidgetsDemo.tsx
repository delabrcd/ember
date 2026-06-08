'use client';

// The Phase C demo gallery body (issue #95). Renders ONE widget of each new
// vizType through the SAME registry/vizRenderer path the dashboard uses, so a
// screenshot proves the renderers work end-to-end (spec → getVizRenderer →
// component), not just in isolation:
//   • scatter  — usage (kWh) vs avg temperature over the REAL `monthly` dataset.
//   • heatmap  — hour-of-day × day usage over a SYNTHETIC interval fixture.
//   • profile  — hour-of-day load profile (±1σ band) over the same fixture.
//
// Why a separate page (not the dashboard): the dashboard must stay screenshot-
// identical, so the new specs are NOT in CHART_SPECS / the default view. This
// gallery is the verification surface. It inherits the app's existing access gate
// (it's just a route) and shows no financial data beyond what the dashboard
// already shows (scatter-over-monthly). Heatmap/profile are clearly-labelled fake.

import { useEffect, useState } from 'react';
import type {
  HeatmapVizSpec,
  MonthRow,
  ProfileVizSpec,
  ScatterVizSpec,
} from '@/lib/chartSpec';
import { getVizRenderer } from '@/lib/widgets/vizRenderers';
import { sampleIntervalRows, type SampleIntervalRow } from '@/lib/viz/sampleInterval';

// --- Demo specs -----------------------------------------------------------
// These are DEMO artifacts, intentionally NOT exported into CHART_SPECS. Each is
// a fully-typed VizSpec: the encoding is checked against the row type, so e.g.
// `x: 'avgTemp'` is a real `MonthRow` numeric field.

const scatterSpec: ScatterVizSpec<MonthRow> = {
  id: 'demo-scatter',
  vizType: 'scatter',
  dataset: 'monthly',
  title: 'Usage vs temperature (scatter)',
  subtitle: 'Each point is a month: avg °F (x) vs electricity kWh (y) — real monthly data',
  encoding: {
    x: 'avgTemp',
    y: 'kwh',
    label: 'label',
    xLabel: 'Avg °F',
    yLabel: 'kWh',
  },
};

const heatmapSpec: HeatmapVizSpec<SampleIntervalRow> = {
  id: 'demo-heatmap',
  vizType: 'heatmap',
  dataset: 'interval',
  title: 'Usage by hour & day (heatmap)',
  subtitle: 'SYNTHETIC sample interval data — hour-of-day (x) × day (y), colored by kWh',
  encoding: {
    x: 'hour',
    y: 'day',
    value: 'kwh',
    yLabelField: 'dayLabel',
    valueLabel: 'kWh',
  },
};

const profileSpec: ProfileVizSpec<SampleIntervalRow> = {
  id: 'demo-profile',
  vizType: 'profile',
  dataset: 'interval',
  title: 'Hour-of-day load profile',
  subtitle: 'SYNTHETIC sample interval data — mean kWh per hour with a ±1σ spread band',
  encoding: {
    bucket: 'hour',
    value: 'kwh',
    agg: 'mean',
    band: true,
    bucketLabel: 'Hour of day',
    valueLabel: 'kWh',
  },
};

function DemoCard({
  title,
  subtitle,
  synthetic,
  children,
}: {
  title: string;
  subtitle: string;
  synthetic?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
          <p className="text-xs text-slate-400">{subtitle}</p>
        </div>
        {synthetic && (
          <span className="pill border-amber-500/40 bg-amber-500/10 text-amber-200">SAMPLE DATA</span>
        )}
      </div>
      {children}
    </div>
  );
}

export function WidgetsDemo() {
  // Real monthly rows for the scatter (same data the dashboard already shows).
  const [monthly, setMonthly] = useState<MonthRow[]>([]);
  useEffect(() => {
    fetch('/api/series', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setMonthly(Array.isArray(d.rows) ? d.rows : []))
      .catch(() => setMonthly([]));
  }, []);

  // Deterministic synthetic interval rows for heatmap + profile (no network).
  const interval = sampleIntervalRows(7);

  // Render each through the registry, exactly as the dashboard's chart widgets do.
  const renderScatter = getVizRenderer('scatter');
  const renderHeatmap = getVizRenderer('heatmap');
  const renderProfile = getVizRenderer('profile');

  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-slate-50">Widget viz gallery</h1>
        <p className="mt-1 text-sm text-slate-400">
          Dev/demo surface for the new visualization renderers (scatter · heatmap · profile).
          Not part of the dashboard. Heatmap &amp; profile use clearly-labelled synthetic sample
          data — real interval data does not exist yet.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DemoCard title={scatterSpec.title} subtitle={scatterSpec.subtitle ?? ''}>
          {renderScatter({ spec: scatterSpec, rows: monthly, fill: false, height: 300 })}
        </DemoCard>

        <DemoCard title={profileSpec.title} subtitle={profileSpec.subtitle ?? ''} synthetic>
          {renderProfile({ spec: profileSpec, rows: interval, fill: false, height: 300 })}
        </DemoCard>

        <DemoCard title={heatmapSpec.title} subtitle={heatmapSpec.subtitle ?? ''} synthetic>
          {renderHeatmap({ spec: heatmapSpec, rows: interval, fill: false, height: 300 })}
        </DemoCard>
      </div>
    </main>
  );
}
