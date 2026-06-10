// Scheduler V2 core types (docs/scheduler-v2-plan.md §3). The stable task-kind
// union plus the runner/handler type surface the generic runner (step 4b) builds
// on. These are TYPES ONLY — the HANDLERS registry is intentionally NOT declared
// here (it lives with the handlers in 4b, to avoid an import cycle / dead ref).
// playwright/PortalSession are imported with `import type` so this stays hermetic.
import type { PortalSession } from '@/lib/ngrid/session';
import type { ProgressFn } from '@/lib/ngrid/types';

export type TaskKind = 'full-scrape' | 'pdf-fetch' | 'interval-pull' | 'weather-sync' | 'notify-sync';

export interface ScheduledTaskRow {
  id: number;
  kind: TaskKind;
  accountId: number | null;
  payload: Record<string, unknown>;
  nextRunAt: Date | null;
  enabled: boolean;
}

export interface ArmSpec { kind: TaskKind; accountId: number | null; nextRunAt: Date; }

export interface TaskResult {
  nextRunAt: Date | null;            // null = deactivate this task
  status: 'SUCCESS' | 'ERROR' | 'SKIPPED';
  reason?: string;
  arm?: ArmSpec[];                   // e.g. full-scrape arms weather/notify/pdf-fetch
}

export interface TaskContext {
  task: ScheduledTaskRow;
  now: Date;
  log: ProgressFn;
  session: PortalSession | null;     // non-null for portal handlers
}

export interface TaskHandler {
  kind: TaskKind;
  portal: boolean;                   // true → needs a PortalSession, runs grouped per login
  run(ctx: TaskContext): Promise<TaskResult>;
}
