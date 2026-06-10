// full-scrape handler — the login-wide pass (docs/scheduler-v2-plan.md §5).
//
// Mirrors run.ts's per-login collect → per-account persist → updateSchedule
// block (run.ts:179-247), expressed as a single TaskHandler that runs against the
// shared PortalSession. collect() scrapes ALL of a login's accounts in one
// session, so this handler DEDUPS per session: the first full-scrape task for a
// login runs collect(); siblings (a multi-account login can have several due
// full-scrape tasks in one tick) return SKIPPED and just recompute their own
// nextRunAt. The runner stays task-agnostic — the dedup lives here via
// session.scratch (§9b).
import { prisma } from '@/lib/db';
import { predictNextBill } from '@/lib/prediction';
import { collect } from '@/lib/ngrid/collect';
import { persist } from '@/lib/ngrid/persist';
import { classifyLoginError, statusOnSuccess } from '@/lib/ngrid/loginStatus';
import {
  computeFullScrapeNextRun,
  PDF_PENDING_RECENT_DAYS,
} from '@/lib/scheduler/cadence';
import type { SanityFlag } from '@/lib/ngrid/sanityFloor';
import type { TaskContext, TaskHandler, TaskResult, ArmSpec } from '@/lib/scheduler/types';

// Backoff when the login pass errors — mirrors run.ts's posture of not idling a
// whole week after a hiccup. ~6h (PDF-pending cadence) is a reasonable retry.
const ERROR_BACKOFF_MS = 6 * 60 * 60 * 1000;
const SCRATCH_KEY = 'fullScrapeDone';

// Persist a scrape-sanity-floor flag (issue #135) as a Notification so a stream
// an established account suddenly returned zero rows for is no longer silent. The
// `key` includes the run's UTC day so repeated ticks the SAME day dedupe (one
// alert per stream per day) but a recurrence on a later day re-fires. Insert-only
// (skipDuplicates) — never clobbers an existing row's readAt/createdAt, matching
// notificationStore's idempotency contract. This is run-state, not anomaly logic
// derived from stored numbers, so a guarded direct insert here is appropriate.
async function recordSanityFlag(accountId: number, flag: SanityFlag, now: Date): Promise<void> {
  const ymd = now.toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  await prisma.notification
    .createMany({
      data: [
        {
          accountId,
          kind: 'scrape',
          key: `scrape-gap:${flag.stream}:${ymd}`,
          title: 'Possible upstream change — empty scrape stream',
          message: `${flag.reason}. Existing rows were preserved (not overwritten). National Grid may have renamed a field; verify the account against the portal.`,
          payload: { stream: flag.stream, prior: flag.prior, reason: flag.reason, ymd },
        },
      ],
      skipDuplicates: true, // (accountId, key) conflict → no-op; one alert/stream/day
    })
    .catch(() => {});
}

// Gather the three cadence facts for an account impurely (statementDates from its
// bills, hasIntervalData from the interval table, hasRecentPendingPdf from recent
// pdfPath=null bills), then compute its full-scrape nextRunAt with the pure
// cadence fn. Returns the computed Date plus hasRecentPendingPdf so the caller can
// arm pdf-fetch only when there's something pending. Mirrors run.ts updateSchedule
// (run.ts:42-83), but the nextCheckAt math is the pure computeFullScrapeNextRun.
async function computeAndWriteSchedule(
  accountId: number,
  now: Date
): Promise<{ nextRunAt: Date; hasRecentPendingPdf: boolean }> {
  const bills = await prisma.bill.findMany({ where: { accountId }, select: { statementDate: true } });
  const statementDates = bills.map((b) => b.statementDate);
  const hasIntervalData = (await prisma.intervalUsage.count({ where: { accountId } })) > 0;
  const pdfCutoff = new Date(now.getTime() - PDF_PENDING_RECENT_DAYS * 24 * 60 * 60 * 1000);
  const hasRecentPendingPdf =
    (await prisma.bill.count({
      where: { accountId, pdfPath: null, statementDate: { gte: pdfCutoff } },
    })) > 0;

  const nextRunAt = computeFullScrapeNextRun(now, { statementDates, hasIntervalData, hasRecentPendingPdf });
  const { predicted } = predictNextBill(statementDates);
  // Keep ScheduleState as the UI's schedule mirror (predicted + nextCheckAt +
  // lastCheckedAt), exactly as run.ts:78-82.
  await prisma.scheduleState.upsert({
    where: { accountId },
    create: { accountId, predictedNextBillDate: predicted, nextCheckAt: nextRunAt, lastCheckedAt: now },
    update: { predictedNextBillDate: predicted, nextCheckAt: nextRunAt, lastCheckedAt: now },
  });
  return { nextRunAt, hasRecentPendingPdf };
}

async function run(ctx: TaskContext): Promise<TaskResult> {
  const { session, now, log, trigger, task } = ctx;
  if (!session) {
    // Should never happen — the runner only dispatches portal handlers with a
    // session. Fail safe rather than crash the tick.
    return { nextRunAt: new Date(now.getTime() + ERROR_BACKOFF_MS), status: 'ERROR', reason: 'no portal session' };
  }

  // Per-session dedup (§9b): a multi-account login can have several due
  // full-scrape tasks; collect() already scrapes all of them in one pass, so the
  // second+ invocation on this session skips and just recomputes its own cadence.
  if (session.scratch[SCRATCH_KEY]) {
    if (task.accountId != null) {
      const { nextRunAt } = await computeAndWriteSchedule(task.accountId, now);
      return { nextRunAt, status: 'SKIPPED', reason: 'covered by sibling full-scrape this tick' };
    }
    return {
      nextRunAt: new Date(now.getTime() + ERROR_BACKOFF_MS),
      status: 'SKIPPED',
      reason: 'covered by sibling full-scrape this tick',
    };
  }

  // Run collect() for this login (loginId from the session). The hasIntervalData
  // probe is the SAME injected probe run.ts:190-197 uses, so a brand-new account
  // gets its one-time wide hourly backfill.
  let results;
  try {
    results = await collect((m) => log(m), {
      loginId: session.loginId,
      session,
      hasIntervalData: async (accountNumber) => {
        const acct = await prisma.account.findUnique({ where: { accountNumber }, select: { id: true } });
        if (!acct) return false;
        return (await prisma.intervalUsage.count({ where: { accountId: acct.id } })) > 0;
      },
    });
    session.scratch[SCRATCH_KEY] = true;
  } catch (loginErr: any) {
    const msg = String(loginErr?.message || loginErr);
    const cls = classifyLoginError(msg);
    // A hard auth failure flips THIS login to needs_reauth and backs off
    // gracefully (mirrors run.ts:199-217) — we never throw out of the handler.
    if (cls.isAuthFailure && session.loginId != null) {
      await prisma.ngLogin
        .update({ where: { id: session.loginId }, data: { status: 'needs_reauth', lastVerifiedAt: undefined } })
        .catch(() => {});
      log(`login ${session.loginId} needs re-authentication: ${cls.reason} — skipping it`);
    }
    // Mark done so siblings on this session don't re-attempt the broken login.
    session.scratch[SCRATCH_KEY] = true;
    return {
      nextRunAt: new Date(now.getTime() + ERROR_BACKOFF_MS),
      status: 'ERROR',
      reason: (cls.isAuthFailure ? cls.reason : msg).slice(0, 200),
    };
  }

  // A login that scraped at least one account is healthy: clear any prior
  // needs_reauth flag and stamp it verified (run.ts:241-246). Env passes (no id).
  if (session.loginId != null && results.length > 0) {
    await prisma.ngLogin
      .update({ where: { id: session.loginId }, data: { status: statusOnSuccess(), lastVerifiedAt: new Date() } })
      .catch(() => {});
  }

  // Persist each account + recompute its schedule, and arm its child tasks.
  const arm: ArmSpec[] = [];
  let thisTaskNextRunAt: Date | null = null;
  let lastNextRunAt: Date | null = null;
  // Scrape metrics summed across the accounts discovered in this pass, so the
  // runner can rebuild the legacy ScrapeRun summary + billsAdded.
  let billsTotal = 0;
  let billsAdded = 0;
  let pdfsDownloaded = 0;
  // Scrape-sanity-floor warnings (issue #135), one per suspect stream, surfaced
  // in the ScrapeRun summary message via metrics.warnings.
  const warnings: string[] = [];
  for (const result of results) {
    // Opt into the scrape sanity floor (issue #135): this is the ONLY caller that
    // persists a full collect() result where bills/usage/costs were all genuinely
    // fetched, so an established stream going to zero here really is suspect. The
    // partial-persist callers (intervalPull/pdfFetch) deliberately leave it off.
    const summary = await persist(result, { detectSanityFloor: true });
    const accountId = summary.accountId;
    billsTotal += summary.billsTotal;
    billsAdded += summary.billsAdded;
    pdfsDownloaded += result.pdfsDownloaded;

    // persist() preserved the existing rows for any stream that came back empty
    // for this ESTABLISHED account; here we make it LOUD — a Notification row per
    // suspect stream and a warning folded into the run summary. A genuinely
    // new/empty account never trips this (the pure detector gates on prior > 0).
    if (summary.sanityFlags?.length) {
      for (const flag of summary.sanityFlags) {
        await recordSanityFlag(accountId, flag, now);
        warnings.push(`acct ${accountId}: ${flag.reason}`);
        log(`scrape sanity floor: acct ${accountId} ${flag.reason} — preserved existing rows, flagged`);
      }
    }
    const { nextRunAt, hasRecentPendingPdf } = await computeAndWriteSchedule(accountId, now);
    lastNextRunAt = nextRunAt;
    if (accountId === task.accountId) thisTaskNextRunAt = nextRunAt;

    // Arm a real per-account full-scrape row at this account's computed cadence.
    // This is the ONLY thing that creates a persisted full-scrape row for an
    // account discovered via the synthetic fresh-install env pass (task.id<0,
    // accountId null): without it no full-scrape row ever exists, needsFreshInstall
    // stays true forever, and the runner re-runs a full env scrape every tick
    // ignoring the back-off. For an account that already owns this task's row the
    // arm upsert sets the same computed nextRunAt the runner writes back — idempotent.
    arm.push({ kind: 'full-scrape', accountId, nextRunAt });

    // Arm child tasks for THIS account.
    arm.push({ kind: 'weather-sync', accountId, nextRunAt: now });
    if (trigger === 'SCHEDULED') {
      // notify-sync only on SCHEDULED → a manual refresh stays silent (run.ts:253).
      arm.push({ kind: 'notify-sync', accountId, nextRunAt: now });
    }
    if (hasRecentPendingPdf) arm.push({ kind: 'pdf-fetch', accountId, nextRunAt: now });
    // interval-pull always armed; it self-skips when there's no AMI meter (the
    // light /dashboard capture decides). Cheap and keeps interval capture going.
    arm.push({ kind: 'interval-pull', accountId, nextRunAt: now });
  }

  // This task's own nextRunAt = its account's computed cadence. If this task's
  // account wasn't among the discovered results (rare — e.g. an account was
  // unlinked), fall back to the last computed cadence or a gentle re-check.
  const nextRunAt = thisTaskNextRunAt ?? lastNextRunAt ?? new Date(now.getTime() + ERROR_BACKOFF_MS);
  return {
    nextRunAt,
    status: 'SUCCESS',
    arm,
    metrics: {
      billsTotal,
      billsAdded,
      pdfsDownloaded,
      accountCount: results.length,
      ...(warnings.length ? { warnings } : {}),
    },
  };
}

export const fullScrapeHandler: TaskHandler = { kind: 'full-scrape', portal: true, run };
