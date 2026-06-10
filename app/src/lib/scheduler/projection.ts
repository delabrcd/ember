// Pure 7-day "upcoming scheduler actions" simulator (docs/scheduler-v2-plan.md §8).
//
// For each enabled task we start a virtual clock at its nextRunAt and repeatedly
// call its PURE cadence fn with facts held CONSTANT across the horizon, appending
// each fire until now + horizonDays. Reactive/inactive tasks (disabled or
// nextRunAt=null) emit a single honest annotation, not a periodic series.
//
// Hermetic: NO prisma/browser imports. All per-task metadata (cadence, trigger/
// collapsed wording, label) comes from the PURE descriptor registry in ./tasks.
import type { TaskKind } from './types';
import { TASK_DEFS } from './tasks';

// Re-export so existing importers of taskKindLabel from this module keep working
// (the canonical source is now the registry).
export { taskKindLabel } from './tasks';

const DAY_MS = 24 * 60 * 60 * 1000;

// Backstop iteration cap: even a 6h cadence over a 14-day horizon is ~56 fires,
// so 200 is comfortably above any honest run and guards a degenerate cadence fn.
const MAX_ITERATIONS = 200;
// Collapse a tight constant cadence into one representative entry when a task
// would fire MORE than this many times in the horizon at a near-constant delta.
const COLLAPSE_MIN_FIRES = 4;
// Two deltas count as "the same cadence" when they differ by < this fraction.
const COLLAPSE_DELTA_TOLERANCE = 0.1;

export interface ProjectedAction {
  kind: TaskKind;
  // Scheduled entries carry their real fire instant; reactive/inactive tasks
  // (no scheduled time) carry null — the UI renders these with no timestamp.
  at: Date | null;
  reason: string;
}

export interface ProjectionTaskInput {
  kind: TaskKind;
  enabled: boolean;
  nextRunAt: Date | null;
  // Facts held CONSTANT across the horizon for this task's cadence fn.
  facts: {
    statementDates?: Date[];
    hasIntervalData?: boolean;
    hasRecentPendingPdf?: boolean;
    hasAmiMeter?: boolean;
  };
}

// Advance a task's virtual clock by one fire using its own cadence fn (from the
// registry) with the held-constant facts. Returns the next fire instant, or null
// to stop (the cadence self-deactivated / the task is reactive).
function nextFire(task: ProjectionTaskInput, virtualNow: Date): Date | null {
  return TASK_DEFS[task.kind].cadence(virtualNow, task.facts);
}

export function projectTask(
  task: ProjectionTaskInput,
  now: Date,
  horizonDays: number
): ProjectedAction[] {
  // Reactive / inactive: a single annotated entry with NO time, never a periodic
  // series. (Defaulting `at` to `now` here would render a bogus "just now".)
  if (!task.enabled || task.nextRunAt == null) {
    return [{ kind: task.kind, at: null, reason: TASK_DEFS[task.kind].inactiveReason }];
  }

  const horizonEnd = now.getTime() + horizonDays * DAY_MS;
  // Don't fire in the past: a nextRunAt already due fires effectively now.
  let clock = new Date(Math.max(task.nextRunAt.getTime(), now.getTime()));
  const fires: Date[] = [];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (clock.getTime() > horizonEnd) break;
    fires.push(clock);
    const next = nextFire(task, clock);
    if (next == null) break; // cadence self-deactivated mid-simulation
    // Guard a zero/negative step to avoid an infinite loop on a degenerate cadence.
    if (next.getTime() <= clock.getTime()) break;
    clock = next;
  }

  if (fires.length === 0) return [];

  // Collapse a tight, roughly-constant cadence (e.g. pdf-fetch held "pending"
  // every ~6h, interval-pull every ~22h) into ONE representative entry. We
  // detect a constant cadence by checking that every consecutive delta is
  // within COLLAPSE_DELTA_TOLERANCE of the first, and only collapse when there
  // are MORE than COLLAPSE_MIN_FIRES fires. Keep the first fire's `at`.
  if (fires.length > COLLAPSE_MIN_FIRES) {
    const firstDelta = fires[1].getTime() - fires[0].getTime();
    const roughlyConstant =
      firstDelta > 0 &&
      fires.every((f, idx) => {
        if (idx === 0) return true;
        const delta = f.getTime() - fires[idx - 1].getTime();
        return Math.abs(delta - firstDelta) <= firstDelta * COLLAPSE_DELTA_TOLERANCE;
      });
    if (roughlyConstant) {
      return [
        { kind: task.kind, at: fires[0], reason: TASK_DEFS[task.kind].collapsedReason(firstDelta) },
      ];
    }
  }

  return fires.map((at) => ({ kind: task.kind, at, reason: 'scheduled' }));
}

export function projectTimeline(
  tasks: ProjectionTaskInput[],
  now: Date,
  days: number
): ProjectedAction[] {
  const actions: ProjectedAction[] = [];
  for (const task of tasks) {
    actions.push(...projectTask(task, now, days));
  }
  // Scheduled entries (at != null) first, ascending by time; reactive entries
  // (at == null) sort last, stable among themselves.
  actions.sort((a, b) => {
    if (a.at == null && b.at == null) return 0;
    if (a.at == null) return 1;
    if (b.at == null) return -1;
    return a.at.getTime() - b.at.getTime();
  });
  return actions;
}
