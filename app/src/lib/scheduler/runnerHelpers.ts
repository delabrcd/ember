// Pure, hermetic helpers for the generic runner (runner.ts imports these). Kept
// in their own module — with NO prisma/playwright import — so the unit suite can
// exercise the decidable bits (due-task splitting, throttle floor, fresh-install
// detection, login grouping, portal ordering) without the prisma singleton or a
// browser. runner.ts holds the impure orchestration.
import type { ScheduledTaskRow, TaskKind } from './types';

// Don't run portal tasks more often than this (mirrors run.ts:17). The runner
// enforces it as a per-tick floor on portal tasks; non-portal exempt.
export const MIN_SCHEDULED_GAP_MS = 5 * 60 * 1000;

// Split due tasks into portal vs non-portal by the handler's `portal` flag.
export function splitDue(
  tasks: ScheduledTaskRow[],
  isPortal: (kind: TaskKind) => boolean
): { portal: ScheduledTaskRow[]; nonPortal: ScheduledTaskRow[] } {
  const portal: ScheduledTaskRow[] = [];
  const nonPortal: ScheduledTaskRow[] = [];
  for (const t of tasks) (isPortal(t.kind) ? portal : nonPortal).push(t);
  return { portal, nonPortal };
}

// Throttle-floor decision: should portal tasks be DEFERRED this tick because the
// most recent SUCCESS run was within gapMs? Returns the Date to push deferred
// portal tasks to (lastSuccess + gap) when deferring, else null (run them).
export function portalDeferUntil(
  lastSuccessAt: Date | null,
  now: Date,
  gapMs: number = MIN_SCHEDULED_GAP_MS
): Date | null {
  if (!lastSuccessAt) return null;
  if (now.getTime() - lastSuccessAt.getTime() < gapMs) {
    return new Date(lastSuccessAt.getTime() + gapMs);
  }
  return null;
}

// Fresh-install detection: no full-scrape task exists at all → synthesize an
// initial full-scrape pass (mirrors scheduler.ts's states.length===0).
export function needsFreshInstall(existingKinds: TaskKind[]): boolean {
  return !existingKinds.includes('full-scrape');
}

// Group portal tasks by login (account.loginId; null/unknown = env pass). The
// string key keeps null and numeric ids distinct.
export function groupByLogin(
  tasks: ScheduledTaskRow[],
  loginOf: (accountId: number | null) => number | undefined
): Map<string, { loginId: number | undefined; tasks: ScheduledTaskRow[] }> {
  const groups = new Map<string, { loginId: number | undefined; tasks: ScheduledTaskRow[] }>();
  for (const t of tasks) {
    const loginId = loginOf(t.accountId);
    const key = loginId === undefined ? 'env' : `login:${loginId}`;
    const g = groups.get(key) ?? { loginId, tasks: [] };
    g.tasks.push(t);
    groups.set(key, g);
  }
  return groups;
}

// Fixed run order for a login's portal handlers (headers warm): full-scrape →
// interval-pull → pdf-fetch. Non-portal kinds sort last (never grouped here).
const PORTAL_ORDER: Record<TaskKind, number> = {
  'full-scrape': 0,
  'interval-pull': 1,
  'pdf-fetch': 2,
  'weather-sync': 9,
  'notify-sync': 9,
};
export function orderPortalTasks(tasks: ScheduledTaskRow[]): ScheduledTaskRow[] {
  return [...tasks].sort((a, b) => (PORTAL_ORDER[a.kind] ?? 9) - (PORTAL_ORDER[b.kind] ?? 9));
}
