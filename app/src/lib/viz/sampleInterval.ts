// SYNTHETIC sample interval data for the Phase C demo gallery (issue #95).
//
// ⚠️ THIS IS NOT REAL DATA. The heatmap and profile vizTypes operate on the AMI
// smart-meter INTERVAL grain (15-min/hourly), which the app does NOT yet have
// (that's the #76–82 cluster; the `interval` DatasetId in datasets.ts is
// reserved and deliberately NOT fetched). To visually verify the heatmap/profile
// renderers BEFORE that data exists, we generate a small, DETERMINISTIC, fake
// hourly load profile here — no network, no DB, no scrape. It is shaped like a
// plausible household electric load (a morning + evening peak, a midday dip, a
// quiet overnight) so the renderers show a recognizable pattern, but every
// number is fabricated. When real `IntervalUsage` lands, the demo swaps this for
// the real rows and the renderers/aggregators don't change.

// One hourly interval reading. Mirrors the field roles the future
// `IntervalUsage` will expose, kept minimal: a day index, an hour-of-day, and
// the usage in that hour. `dayLabel` is a display string for the heatmap's y axis.
export interface SampleIntervalRow {
  day: number; // 0-based day index within the sample window
  dayLabel: string; // e.g. 'Mon' — display only
  hour: number; // hour-of-day, 0–23
  kwh: number; // synthetic usage for that hour (kWh)
}

// A deterministic pseudo-random generator (mulberry32) so the sample is the SAME
// on every render/build — a screenshot diff of the demo page is stable, and the
// hand-calc tests can rely on a fixed shape. Seeded, no Math.random().
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The base "typical day" hourly shape (kWh), index = hour 0–23. A quiet night,
// a morning ramp (~7am), a midday dip, and a tall evening peak (~6–8pm) — the
// classic residential duck-ish curve. These are illustrative constants only.
const BASE_HOURLY: readonly number[] = [
  0.3, 0.25, 0.22, 0.2, 0.22, 0.35, 0.7, 1.2, 1.1, 0.9, 0.8, 0.85, // 0–11
  0.9, 0.85, 0.8, 0.95, 1.3, 2.1, 2.6, 2.4, 1.8, 1.2, 0.7, 0.4, // 12–23
];

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Generate `days` days × 24 hours of synthetic hourly rows. Each day jitters the
// base shape a little (weekday vs weekend bump, seeded noise) so the heatmap has
// visible day-to-day variation and the profile band is non-trivial — while
// staying fully deterministic.
export function sampleIntervalRows(days = 7, seed = 95): SampleIntervalRow[] {
  const rnd = mulberry32(seed);
  const rows: SampleIntervalRow[] = [];
  for (let day = 0; day < days; day++) {
    const label = DAY_LABELS[day % DAY_LABELS.length];
    const isWeekend = label === 'Sat' || label === 'Sun';
    // Weekends shift load later and a touch higher midday (home all day).
    const weekendMidday = isWeekend ? 0.4 : 0;
    for (let hour = 0; hour < 24; hour++) {
      const noise = (rnd() - 0.5) * 0.2; // ±0.1 kWh seeded jitter
      const middayBump = hour >= 10 && hour <= 16 ? weekendMidday : 0;
      const kwh = Math.max(0, BASE_HOURLY[hour] + middayBump + noise);
      rows.push({ day, dayLabel: label, hour, kwh: Math.round(kwh * 1000) / 1000 });
    }
  }
  return rows;
}
