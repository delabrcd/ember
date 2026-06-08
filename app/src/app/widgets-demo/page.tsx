import { WidgetsDemo } from '@/components/WidgetsDemo';

// DEV/DEMO GALLERY for the Phase C vizTypes (issue #95). This route exists ONLY
// to visually verify the scatter / heatmap / profile renderers in isolation; it
// is NOT linked from the dashboard and is NOT part of the default view, so the
// real dashboard stays screenshot-identical (the new vizTypes are deliberately
// absent from CHART_SPECS).
//
// Access: it's just another page under the same app, so it INHERITS the existing
// access gate (LAN-only / reverse-proxy / SSO — AGENTS.md rule 5). It adds NO
// auth and exposes nothing new un-gated: the scatter is over the SAME `monthly`
// data the dashboard already shows; the heatmap/profile use a clearly-labelled
// SYNTHETIC interval fixture (no real interval data exists yet — #76).

export const dynamic = 'force-dynamic';

export default function WidgetsDemoPage() {
  return <WidgetsDemo />;
}
