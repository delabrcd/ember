// Pure per-task descriptor registry (docs/scheduler-v2-plan.md §3-§5).
//
// ONE entry per TaskKind co-locates every piece of per-task metadata that used
// to be scattered across switch statements: the portal flag + run order (was the
// runner's orderPortalTasks/HANDLERS[k].portal), the UI label (was projection's
// taskKindLabel), the projection cadence (was projection's nextFire switch), and
// the human trigger/collapsed wording (was projection's inactiveReason/
// collapsedReason switches). Adding a task kind is now: add a TASK_DEFS entry +
// a handler `run` — nothing else.
//
// Hermetic: NO prisma/playwright/@/lib/db imports. Safe for projection.ts (the
// 7-day simulator), SettingsView.tsx (the client), and the runner's ordering. The
// impure `run()` stays in handlers/*.ts; HANDLERS maps kind → handler for the
// runner to invoke. The registry is authoritative for portal/order/label/cadence.
import type { TaskKind } from './types';
import {
  computeFullScrapeNextRun,
  computePdfFetchNextRun,
  computeIntervalNextRun,
} from './cadence';

// Unified fact bag the projection gathers and holds CONSTANT across the horizon;
// each task's cadence reads only the fields it needs.
export interface ProjectionFacts {
  statementDates?: Date[];
  hasIntervalData?: boolean;
  hasRecentPendingPdf?: boolean;
  hasAmiMeter?: boolean;
}

export interface TaskDef {
  kind: TaskKind;
  // true → needs a PortalSession, runs grouped per login.
  portal: boolean;
  // Portal run order within a login (lower first; headers warm). Non-portal kinds
  // sort last among themselves.
  order: number;
  // UI label for the "upcoming actions" table (was taskKindLabel).
  label: string;
  // Next fire from a virtual clock for the projection simulator; null = reactive /
  // no periodic cadence (the projection emits a single annotation instead).
  cadence: (now: Date, facts: ProjectionFacts) => Date | null;
  // Trigger text shown when a task has no fixed time (was inactiveReason). Says
  // WHAT KICKS IT OFF in plain language, not jargon.
  inactiveReason: string;
  // Wording for a collapsed tight constant cadence (was collapsedReason(deltaMs)).
  // `deltaMs` is the near-constant gap between consecutive fires.
  collapsedReason: (deltaMs: number) => string;
}

export const TASK_DEFS: Record<TaskKind, TaskDef> = {
  'full-scrape': {
    kind: 'full-scrape',
    portal: true,
    order: 0,
    label: 'Full check',
    cadence: (now, f) =>
      computeFullScrapeNextRun(now, {
        statementDates: f.statementDates ?? [],
        hasIntervalData: f.hasIntervalData ?? false,
        hasRecentPendingPdf: f.hasRecentPendingPdf ?? false,
      }),
    inactiveReason: 'Triggered by a full check',
    collapsedReason: (deltaMs) => {
      const hours = deltaMs / (60 * 60 * 1000);
      // ≥~20h reads as "about daily"; otherwise quote the rounded hour cadence.
      if (hours >= 20) return 'recurring about daily';
      return `recurring about every ${Math.round(hours)}h`;
    },
  },
  'interval-pull': {
    kind: 'interval-pull',
    portal: true,
    order: 1,
    label: 'Pull interval usage',
    cadence: (now, f) => computeIntervalNextRun(now, { hasAmiMeter: f.hasAmiMeter ?? false }),
    inactiveReason: 'No smart meter on this account — won’t run',
    collapsedReason: () => '~daily while AMI interval data is captured',
  },
  'pdf-fetch': {
    kind: 'pdf-fetch',
    portal: true,
    order: 2,
    label: 'Fetch bill PDF',
    cadence: (now, f) =>
      computePdfFetchNextRun(now, { hasRecentPendingPdf: f.hasRecentPendingPdf ?? false }),
    inactiveReason: 'Runs when a new bill is found but its PDF hasn’t published yet',
    collapsedReason: () => 'every ~6h until the PDF publishes, then relaxes',
  },
  'weather-sync': {
    kind: 'weather-sync',
    portal: false,
    order: 10,
    label: 'Sync weather',
    cadence: () => null,
    inactiveReason: 'Runs right after each full check',
    // Reactive: never collapses (no periodic cadence). Generic fallback only.
    collapsedReason: () => 'recurring',
  },
  'notify-sync': {
    kind: 'notify-sync',
    portal: false,
    order: 11,
    label: 'Send notifications',
    cadence: () => null,
    inactiveReason: 'Runs right after each full check (new-bill / anomaly alerts)',
    collapsedReason: () => 'recurring',
  },
};

// Human label for a task kind, for the "upcoming actions" UI. Pure + total over
// TaskKind (sourced from the registry).
export const taskKindLabel = (kind: TaskKind): string => TASK_DEFS[kind].label;
