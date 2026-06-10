// Scheduler V2 generic task-runner (docs/scheduler-v2-plan.md §4).
//
// The scheduler is now task-AGNOSTIC: each tick it loads due ScheduledTask rows,
// dispatches each to its handler by `kind`, and writes back whatever nextRunAt
// (null = deactivate) the handler returns. It knows nothing about scrapes —
// cadence lives in the handlers' pure cadence fns. Good-guest invariants
// (docs §10): ≤1 acquirePortalSession per login per tick; a login's portal
// handlers run SEQUENTIALLY on the single page (shared mutable browser state is
// never touched concurrently); the 5-min portal floor is enforced here.
//
// This is the sole scrape path: scheduler.tickOnce() calls runTick('SCHEDULED')
// and the refresh route calls runManual().
import { prisma } from '@/lib/db';
import { bootstrapEnvLogin } from '@/lib/ngrid/bootstrap';
import { isSchedulerEnabled } from '@/lib/settings';
import { acquirePortalSession } from '@/lib/ngrid/session';
import type { PortalSession } from '@/lib/ngrid/session';
import { shouldSkipScheduled } from '@/lib/ngrid/loginStatus';
import { seedScheduledTasks } from '@/lib/scheduler/seed';
import { runWithScrapeRun } from '@/lib/scheduler/progress';
import { HANDLERS } from '@/lib/scheduler/handlers';
import { TASK_DEFS } from '@/lib/scheduler/tasks';
import {
  groupByLogin,
  needsFreshInstall,
  orderPortalTasks,
  portalDeferUntil,
  splitDue,
} from '@/lib/scheduler/runnerHelpers';
import type { ProgressFn } from '@/lib/ngrid/types';
import type { ScheduledTaskRow, TaskKind, TaskResult, TaskContext, ArmSpec } from '@/lib/scheduler/types';

// Backoff written to a portal task whose handler throws unexpectedly (the handler
// is supposed to catch its own errors; this is belt-and-suspenders so a thrown
// task gets a sane retry instead of being re-tried every tick).
const ERROR_BACKOFF_MS = 6 * 60 * 60 * 1000;

// Process guard so the bootstrap + seed only run their DB work once per process
// (both are also DB-idempotent, so a guard miss is harmless). Mirrors
// scheduler.ts's bootstrapRan.
let bootstrapped = false;

// ---- impure orchestration (pure helpers live in runnerHelpers.ts) ---------

// Map a Prisma scheduledTask row to the runner's ScheduledTaskRow shape.
function toRow(t: {
  id: number;
  kind: string;
  accountId: number | null;
  payload: unknown;
  nextRunAt: Date | null;
  enabled: boolean;
}): ScheduledTaskRow {
  return {
    id: t.id,
    kind: t.kind as TaskKind,
    accountId: t.accountId,
    payload: (t.payload as Record<string, unknown>) ?? {},
    nextRunAt: t.nextRunAt,
    enabled: t.enabled,
  };
}

// Write back a task's outcome (nextRunAt + audit fields). Best-effort.
async function writeBack(taskId: number, now: Date, result: TaskResult): Promise<void> {
  await prisma.scheduledTask
    .update({
      where: { id: taskId },
      data: {
        nextRunAt: result.nextRunAt,
        lastRunAt: now,
        lastStatus: result.status,
        lastReason: result.reason ? result.reason.slice(0, 200) : null,
      },
    })
    .catch(() => {});
}

// Apply a handler's arm[] entries: upsert each armed task's nextRunAt WITHOUT
// resetting its other fields. The compound-unique [kind, accountId] is the key
// (mirrors seed). A newly-discovered account's child task is created here.
async function applyArm(arm: ArmSpec[] | undefined): Promise<void> {
  if (!arm?.length) return;
  for (const a of arm) {
    // Every arm targets a concrete discovered account (full-scrape arms its
    // children by id); a null-account arm has no compound-unique target, so skip
    // it. (Prisma's kind_accountId where requires a non-null accountId.)
    if (a.accountId == null) continue;
    await prisma.scheduledTask
      .upsert({
        where: { kind_accountId: { kind: a.kind, accountId: a.accountId } },
        create: { kind: a.kind, accountId: a.accountId, nextRunAt: a.nextRunAt, enabled: true, payload: {} },
        update: { nextRunAt: a.nextRunAt, enabled: true },
      })
      .catch(() => {});
  }
}

// Run one portal handler in its own try/catch, write back its result + apply its
// arms, and fold its outcome into the running summary. A failing task records
// ERROR + backoff and NEVER aborts siblings or the tick.
async function runPortalTask(
  task: ScheduledTaskRow,
  session: PortalSession,
  now: Date,
  trigger: 'SCHEDULED' | 'MANUAL',
  log: ProgressFn,
  acc: RunAccumulator
): Promise<void> {
  const ctx: TaskContext = { task, now, log, session, trigger };
  try {
    const result = await HANDLERS[task.kind].run(ctx);
    await writeBack(task.id, now, result);
    await applyArm(result.arm);
    acc.note(task.kind, result.status, result.metrics);
  } catch (err: any) {
    log(`task ${task.kind}#${task.accountId ?? '-'} failed: ${String(err?.message || err).slice(0, 200)}`);
    await writeBack(task.id, now, {
      nextRunAt: new Date(now.getTime() + ERROR_BACKOFF_MS),
      status: 'ERROR',
      reason: String(err?.message || err).slice(0, 200),
    });
    acc.note(task.kind, 'ERROR');
  }
}

// Small mutable accumulator for the ScrapeRun final summary. Tracks per-task
// counts AND the scrape metrics (bills/new/PDFs/accounts) folded in from each
// task result so summary()/billsAdded match the legacy run.ts contract.
class RunAccumulator {
  ran = 0;
  errors = 0;
  byKind: Record<string, number> = {};
  firstAccountId?: number;
  billsTotal = 0;
  billsAdded = 0;
  pdfsDownloaded = 0;
  accountCount = 0;
  sawMetrics = false;
  warnings: string[] = [];
  // Record a task outcome and fold in any scrape metrics it reported.
  note(kind: TaskKind, status: TaskResult['status'], metrics?: TaskResult['metrics']): void {
    this.ran += 1;
    if (status === 'ERROR') this.errors += 1;
    this.byKind[kind] = (this.byKind[kind] ?? 0) + 1;
    if (metrics) {
      this.sawMetrics = true;
      this.billsTotal += metrics.billsTotal ?? 0;
      this.billsAdded += metrics.billsAdded ?? 0;
      this.pdfsDownloaded += metrics.pdfsDownloaded ?? 0;
      this.accountCount += metrics.accountCount ?? 0;
      if (metrics.warnings?.length) this.warnings.push(...metrics.warnings);
    }
  }
  summary(): string {
    const parts = Object.entries(this.byKind).map(([k, n]) => `${k}×${n}`);
    const taskCounts = `${this.ran} task(s)${parts.length ? ': ' + parts.join(', ') : ''}${this.errors ? `; ${this.errors} error(s)` : ''}`;
    // Suspected zero-row stream(s) (issue #135) get surfaced FIRST so the warning
    // is impossible to miss in the run summary the UI's recent-checks shows.
    const warn = this.warnings.length ? `⚠ ${this.warnings.join('; ')}. ` : '';
    // When a scrape ran, lead with the legacy-spirit metrics line (the UI's
    // recent-checks shows this), then keep the per-task counts (still useful).
    if (this.sawMetrics) {
      return `${warn}${this.accountCount} account(s): ${this.billsTotal} bills (${this.billsAdded} new), ${this.pdfsDownloaded} PDFs; ${taskCounts}`;
    }
    return `${warn}${taskCounts}`;
  }
}

// Core portal+nonportal dispatch shared by the scheduled tick and the manual
// pass. Acquires ONE session per login, runs that login's portal tasks
// sequentially in fixed order, then runs non-portal tasks. Returns the summary
// for the ScrapeRun row.
async function dispatch(
  portalTasks: ScheduledTaskRow[],
  nonPortalTasks: ScheduledTaskRow[],
  trigger: 'SCHEDULED' | 'MANUAL',
  now: Date,
  log: ProgressFn,
  skipNeedsReauth: boolean,
  // Optional shared accumulator so a multi-pass tick (synthetic fresh-install
  // pass + persistable pass) folds its scrape metrics into ONE ScrapeRun summary.
  sharedAcc?: RunAccumulator
): Promise<{ summaryMessage: string; billsAdded: number; accountId?: number }> {
  const acc = sharedAcc ?? new RunAccumulator();

  // Resolve each portal task's login (account.loginId; env pass = undefined).
  const accountIds = [...new Set(portalTasks.map((t) => t.accountId).filter((x): x is number => x != null))];
  const accounts = accountIds.length
    ? await prisma.account.findMany({ where: { id: { in: accountIds } }, select: { id: true, loginId: true } })
    : [];
  const loginByAccount = new Map<number, number | null>(accounts.map((a) => [a.id, a.loginId]));
  const loginOf = (accountId: number | null): number | undefined => {
    if (accountId == null) return undefined; // global/env task
    const l = loginByAccount.get(accountId);
    return l == null ? undefined : l; // unknown account or null login → env pass
  };

  // Which logins are flagged needs_reauth (skip on a SCHEDULED tick).
  const loginIds = [...new Set(accounts.map((a) => a.loginId).filter((x): x is number => x != null))];
  const reauth = new Set<number>();
  if (skipNeedsReauth && loginIds.length) {
    const logins = await prisma.ngLogin.findMany({ where: { id: { in: loginIds } }, select: { id: true, status: true } });
    for (const l of logins) if (shouldSkipScheduled(l.status)) reauth.add(l.id);
  }

  const groups = groupByLogin(portalTasks, loginOf);
  if (acc.firstAccountId === undefined) {
    const firstWithAccount = portalTasks.find((t) => t.accountId != null);
    if (firstWithAccount?.accountId != null) acc.firstAccountId = firstWithAccount.accountId;
  }

  // Portal tasks: one session per login, sequential. Never parallel logins.
  for (const { loginId, tasks } of groups.values()) {
    if (skipNeedsReauth && loginId != null && reauth.has(loginId)) {
      log(`skipping login ${loginId} (needs re-authentication)`);
      for (const t of tasks) {
        await writeBack(t.id, now, {
          nextRunAt: new Date(now.getTime() + ERROR_BACKOFF_MS),
          status: 'SKIPPED',
          reason: 'login needs re-authentication',
        });
      }
      continue;
    }

    let session: PortalSession | null = null;
    try {
      session = await acquirePortalSession(loginId, log);
    } catch (err: any) {
      log(`login ${loginId ?? '(env)'} session failed: ${String(err?.message || err).slice(0, 200)}`);
      for (const t of tasks) {
        await writeBack(t.id, now, {
          nextRunAt: new Date(now.getTime() + ERROR_BACKOFF_MS),
          status: 'ERROR',
          reason: 'could not acquire portal session',
        });
        acc.note(t.kind, 'ERROR');
      }
      continue;
    }

    try {
      for (const task of orderPortalTasks(tasks)) {
        await runPortalTask(task, session, now, trigger, log, acc);
      }
    } finally {
      await session.saveState().catch(() => {});
      await session.close().catch(() => {});
    }
  }

  // Non-portal tasks: each isolated in try/catch.
  for (const task of nonPortalTasks) {
    const ctx: TaskContext = { task, now, log, session: null, trigger };
    try {
      const result = await HANDLERS[task.kind].run(ctx);
      await writeBack(task.id, now, result);
      await applyArm(result.arm);
      acc.note(task.kind, result.status, result.metrics);
    } catch (err: any) {
      log(`task ${task.kind}#${task.accountId ?? '-'} failed: ${String(err?.message || err).slice(0, 200)}`);
      await writeBack(task.id, now, { nextRunAt: null, status: 'ERROR', reason: String(err?.message || err).slice(0, 200) });
      acc.note(task.kind, 'ERROR');
    }
  }

  // Return the real summed new-bill count so runWithScrapeRun writes
  // ScrapeRun.billsAdded correctly (was hardcoded 0).
  return { summaryMessage: acc.summary(), billsAdded: acc.billsAdded, accountId: acc.firstAccountId };
}

// One-time process bootstrap (env→NgLogin cutover + seed the ScheduledTask rows).
// Both are idempotent; the guard just avoids re-querying every tick.
async function ensureBootstrapped(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  await bootstrapEnvLogin();
  await seedScheduledTasks(prisma).catch(() => {});
}

// SCHEDULED tick entry point — replaces tickOnce's body behind the flag.
export async function runTick(
  trigger: 'SCHEDULED' = 'SCHEDULED'
): Promise<{ ran: boolean; reason: string }> {
  await ensureBootstrapped();
  if (!(await isSchedulerEnabled())) return { ran: false, reason: 'disabled' };

  const now = new Date();

  // Fresh-install: if NO full-scrape task exists at all, synthesize an initial
  // full-scrape pass (mirrors scheduler.ts's states.length===0). seed already
  // creates per-account full-scrape rows; this covers a zero-account DB where the
  // very first scrape must discover the account via an env pass.
  const allKinds = (await prisma.scheduledTask.findMany({ select: { kind: true }, distinct: ['kind'] })).map(
    (t) => t.kind as TaskKind
  );
  const freshInstall = needsFreshInstall(allKinds);

  const dueRows = await prisma.scheduledTask.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
  });
  let due = dueRows.map(toRow);

  // On a fresh install with nothing seeded yet, inject a synthetic env-pass
  // full-scrape (accountId null) so the first run discovers + seeds the account.
  if (freshInstall && !due.some((t) => t.kind === 'full-scrape')) {
    due = [
      { id: -1, kind: 'full-scrape', accountId: null, payload: {}, nextRunAt: now, enabled: true },
      ...due,
    ];
  }

  if (due.length === 0) return { ran: false, reason: 'not-due' };

  const { portal, nonPortal } = splitDue(due, (k) => TASK_DEFS[k].portal);

  // Throttle floor: if any portal task is due and the most recent SUCCESS run is
  // within MIN_SCHEDULED_GAP_MS, DEFER the portal tasks (push nextRunAt forward,
  // don't run them this tick). Non-portal exempt.
  let runnablePortal = portal;
  if (portal.length) {
    const lastSuccess = await prisma.scrapeRun.findFirst({
      where: { status: 'SUCCESS' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    const deferUntil = portalDeferUntil(lastSuccess?.startedAt ?? null, now);
    if (deferUntil) {
      for (const t of portal) {
        if (t.id > 0) {
          await prisma.scheduledTask.update({ where: { id: t.id }, data: { nextRunAt: deferUntil } }).catch(() => {});
        }
      }
      runnablePortal = [];
    }
  }

  if (runnablePortal.length === 0 && nonPortal.length === 0) {
    return { ran: false, reason: 'throttled' };
  }

  // The synthetic fresh-install task (id<0) is not persisted; we never write back
  // to it. Its handler still seeds the discovered account's real tasks via arm[]
  // + persist + seedScheduledTasks on the next tick.
  const persistablePortal = runnablePortal.filter((t) => t.id > 0);
  const syntheticPortal = runnablePortal.filter((t) => t.id <= 0);

  await runWithScrapeRun(trigger, async (progress) => {
    // Run synthetic (fresh-install) full-scrape(s) first under the same session
    // machinery, then the persistable portal tasks, then non-portal. A shared
    // accumulator folds BOTH passes' scrape metrics into the one ScrapeRun summary
    // (on a fresh install the synthetic pass IS the scrape — its bills/PDFs would
    // otherwise be lost).
    const acc = new RunAccumulator();
    if (syntheticPortal.length) {
      await dispatch(syntheticPortal, [], trigger, now, progress, /*skipNeedsReauth*/ true, acc);
    }
    return dispatch(persistablePortal, nonPortal, trigger, now, progress, /*skipNeedsReauth*/ true, acc);
  });

  return { ran: true, reason: freshInstall ? 'initial' : 'due' };
}

// MANUAL pass — a full portal pass NOW for all accounts, bypassing
// nextRunAt/throttle (operator: "manual runs everything", run.ts:160 semantics).
// trigger='MANUAL' → full-scrape does NOT arm notify-sync (manual stays silent);
// weather still runs. Shares the same inFlight lock via runWithScrapeRun, so a
// manual run + a scheduled tick can never double-run (the second → ScrapeBusyError
// → 409). Returns the ScrapeRun id (the refresh route's contract).
export async function runManual(): Promise<number> {
  await ensureBootstrapped();

  const now = new Date();
  // Force-run full-scrape (+interval +pdf) for every account regardless of
  // nextRunAt. Build the task set from the accounts (and an env pass if there are
  // none) rather than the due query.
  const accounts = await prisma.account.findMany({ select: { id: true } });

  return runWithScrapeRun('MANUAL', async (progress) => {
    if (accounts.length === 0) {
      // No accounts yet → a single env-credential full-scrape pass to discover them.
      const synthetic: ScheduledTaskRow[] = [
        { id: -1, kind: 'full-scrape', accountId: null, payload: {}, nextRunAt: now, enabled: true },
      ];
      // MANUAL: don't skip needs_reauth (the operator asked for it; run.ts:159).
      return dispatch(synthetic, [], 'MANUAL', now, progress, /*skipNeedsReauth*/ false);
    }

    // One in-memory portal task per account per portal kind. These are real DB
    // rows (seeded), so we load them and force nextRunAt=now in memory; the
    // handlers compute the real cadence and writeBack persists it.
    const portalRows = await prisma.scheduledTask.findMany({
      where: { accountId: { in: accounts.map((a) => a.id) }, kind: { in: ['full-scrape', 'interval-pull', 'pdf-fetch'] } },
    });
    const portal = portalRows.map(toRow).filter((t) => t.enabled);
    // Ensure a full-scrape exists for every account even if seed hasn't created
    // one yet (defensive): synthesize an in-memory one (id<0). dispatch() writes
    // back per task; an update on a missing id is best-effort-caught, so a
    // synthetic row simply runs the handler (which arms/seeds the real rows) and
    // its write-back no-ops.
    for (const a of accounts) {
      if (!portal.some((t) => t.kind === 'full-scrape' && t.accountId === a.id)) {
        portal.push({ id: -1, kind: 'full-scrape', accountId: a.id, payload: {}, nextRunAt: now, enabled: true });
      }
    }
    return dispatch(portal, [], 'MANUAL', now, progress, /*skipNeedsReauth*/ false);
  });
}
