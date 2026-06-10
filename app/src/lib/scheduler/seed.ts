// Scheduler V2 seed/backfill (docs/scheduler-v2-plan.md §2 "Seed / backfill").
// Idempotently materializes the per-account ScheduledTask rows for the generic
// runner. Split into a PURE planner (planAccountTasks) that unit tests can call
// with hand-built facts, and an IMPURE shell (seedScheduledTasks) that gathers
// those facts from the DB and upserts.
//
// HERMETICITY: this file has NO runtime prisma import — the PrismaClient is a
// TYPE-ONLY import (erased at compile) and injected into seedScheduledTasks. That
// keeps the unit suite free of the prisma singleton (mirrors collect.ts's
// dependency-injection pattern), so planAccountTasks can be tested in isolation.
//
// Wired into the runner's one-time bootstrap (ensureBootstrapped → seedScheduledTasks).
import type { PrismaClient } from '@prisma/client';
import type { TaskKind } from './types';
import { PDF_PENDING_RECENT_DAYS } from '@/lib/scheduler/cadence';

export interface AccountSeedFacts {
  scheduleNextCheckAt: Date | null;
  hasRecentPendingPdf: boolean;
}

export interface SeedTaskSpec {
  kind: TaskKind;
  nextRunAt: Date | null;
}

// PURE. Given the facts gathered for one account and the current instant, decide
// the initial ScheduledTask rows + their nextRunAt. Returned in a stable order.
export function planAccountTasks(facts: AccountSeedFacts, now: Date): SeedTaskSpec[] {
  return [
    // Preserve a live cadence if a ScheduleState already exists; else run now.
    { kind: 'full-scrape', nextRunAt: facts.scheduleNextCheckAt ?? now },
    // Enabled; the handler self-deactivates on first run if there's no AMI meter.
    { kind: 'interval-pull', nextRunAt: now },
    // Run now only if a recent bill is still missing its PDF; full-scrape re-arms it.
    { kind: 'pdf-fetch', nextRunAt: facts.hasRecentPendingPdf ? now : null },
    // Reactive — armed by full-scrape after a successful scrape.
    { kind: 'weather-sync', nextRunAt: null },
    { kind: 'notify-sync', nextRunAt: null },
  ];
}

// IMPURE shell. Loads each account + its ScheduleState, computes whether it has a
// recent pending PDF, runs the pure planner, and idempotently upserts each spec.
//
// Zero accounts → seeds nothing (no-op; does NOT throw on an empty DB).
export async function seedScheduledTasks(db: PrismaClient, now: Date = new Date()): Promise<void> {
  const accounts = await db.account.findMany({
    select: { id: true, scheduleState: { select: { nextCheckAt: true } } },
  });

  const pdfCutoff = new Date(now.getTime() - PDF_PENDING_RECENT_DAYS * 24 * 60 * 60 * 1000);

  for (const account of accounts) {
    const pending = await db.bill.count({
      where: { accountId: account.id, pdfPath: null, statementDate: { gte: pdfCutoff } },
    });
    const specs = planAccountTasks(
      {
        scheduleNextCheckAt: account.scheduleState?.nextCheckAt ?? null,
        hasRecentPendingPdf: pending > 0,
      },
      now
    );

    for (const spec of specs) {
      // Idempotent upsert by the compound-unique [kind, accountId]. The empty
      // `update: {}` is the idempotency guarantee: re-running (restart /
      // multi-process boot) is a no-op that NEVER resets a live task's nextRunAt.
      await db.scheduledTask.upsert({
        where: { kind_accountId: { kind: spec.kind, accountId: account.id } },
        create: { kind: spec.kind, accountId: account.id, nextRunAt: spec.nextRunAt, enabled: true, payload: {} },
        update: {},
      });
    }
  }
}
