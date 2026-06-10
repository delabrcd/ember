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

// Scrape metrics a handler optionally reports so the runner can rebuild the
// legacy ScrapeRun summary ("N account(s): X bills (Y new), Z PDFs fetched") and
// write the real ScrapeRun.billsAdded the UI's recent-checks reads. Only
// full-scrape currently populates these; the runner sums them across tasks.
export interface TaskMetrics {
  billsTotal?: number;
  billsAdded?: number;
  pdfsDownloaded?: number;
  accountCount?: number;
  // Human-readable warnings folded into the ScrapeRun summary message so a
  // silent zero-row stream (issue #135 scrape sanity floor) is VISIBLE in the run
  // summary, not just buried in a Notification. Each entry is one suspect stream,
  // e.g. "acct 12: had 27 bills, scrape returned 0". Empty/absent in the healthy
  // case.
  warnings?: string[];
}

export interface TaskResult {
  nextRunAt: Date | null;            // null = deactivate this task
  status: 'SUCCESS' | 'ERROR' | 'SKIPPED';
  reason?: string;
  arm?: ArmSpec[];                   // e.g. full-scrape arms weather/notify/pdf-fetch
  metrics?: TaskMetrics;             // scrape counts folded into the ScrapeRun summary
}

export interface TaskContext {
  task: ScheduledTaskRow;
  now: Date;
  log: ProgressFn;
  session: PortalSession | null;     // non-null for portal handlers
  // What kicked this tick off. full-scrape arms notify-sync only on SCHEDULED so
  // a MANUAL refresh stays silent (mirrors run.ts:253's trigger==='SCHEDULED'
  // guard); weather-sync is armed on both.
  trigger: 'SCHEDULED' | 'MANUAL';
}

export interface TaskHandler {
  kind: TaskKind;
  portal: boolean;                   // true → needs a PortalSession, runs grouped per login
  run(ctx: TaskContext): Promise<TaskResult>;
}
