// Scheduler audit + live-progress + in-flight-lock wrapper.
//
// Wraps a whole tick in a ScrapeRun audit row + throttled live-progress writer +
// finalize logic, so the UI's ScrapeRun mirror, the /api/refresh/[id] live
// progress, and the manual/scheduled mutual exclusion all behave consistently.
// The runner (runner.ts) is the sole caller.
//
// The ScrapeBusyError / ScrapeThrottledError sentinels are defined here (the
// refresh route's `instanceof` checks import them from this module).
import { prisma } from '@/lib/db';
import { formatProgressLine } from '@/lib/ngrid/progress';
import {
  decideScrapeClaim,
  SCRAPE_CLAIM_ADVISORY_KEY,
  SCRAPE_STALE_AFTER_MS,
} from '@/lib/scheduler/scrapeLock';
import type { ProgressFn } from '@/lib/ngrid/types';

export class ScrapeBusyError extends Error {}
export class ScrapeThrottledError extends Error {}

// Don't write a live-progress update to the DB more often than this. Bursty
// steps collapse to one write per window; the trailing edge always flushes the
// latest line.
const PROGRESS_THROTTLE_MS = 1000;

// In-flight guard (in-process fast path). A single module-level lock governs the
// scheduler within ONE process: a manual run and a scheduled tick can never
// double-run — the second to arrive throws ScrapeBusyError. Cleared in the
// finally below. This is the cheapest guard for the common single-process case;
// the cross-process claim below (issue #136) backs it for the horizontal-scale /
// multi-worker case where two processes would each pass this check.
let inFlight: Promise<number> | null = null;

export interface RunBodyResult {
  summaryMessage: string;
  billsAdded: number;
  accountId?: number;
}

// Wrap a unit of work in a ScrapeRun audit row with the throttled live-progress
// writer. Creates the row (RUNNING), builds the
// throttled `progress` ProgressFn, runs `body(progress)`, then finalizes SUCCESS
// (with the returned summary) or ERROR. Returns the ScrapeRun id immediately; the
// body keeps running in the background (callers poll /api/refresh/[id]). Throws
// ScrapeBusyError if a run is already in flight.
export async function runWithScrapeRun(
  trigger: 'MANUAL' | 'SCHEDULED',
  body: (progress: ProgressFn) => Promise<RunBodyResult>
): Promise<number> {
  if (inFlight) throw new ScrapeBusyError('A scrape is already running');

  // Cross-process claim (issue #136): the in-memory `inFlight` check only guards a
  // single Node process; a second replica/worker would each pass it and log in
  // concurrently, breaking the never-two-concurrent-logins invariant. Make the
  // claim atomic + durable in Postgres: take a transaction-scoped advisory lock
  // (serializes concurrent claimers; auto-released at COMMIT/ROLLBACK and on
  // connection close, so it can never deadlock a crashed claimer), read the latest
  // RUNNING ScrapeRun (the durable cross-process flag), and let the pure
  // decideScrapeClaim() say CLAIM or BUSY. On CLAIM, create the new RUNNING row
  // INSIDE the same transaction so read+claim is atomic under the lock. The
  // transaction is fast (<1s) and the lock releases at COMMIT — long before the
  // ~300s scrape body runs; the RUNNING row, finalized to SUCCESS/ERROR below, is
  // what blocks other processes, and goes stale after SCRAPE_STALE_AFTER_MS so a
  // crashed-mid-scrape run never blocks all future ticks forever.
  const run = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${SCRAPE_CLAIM_ADVISORY_KEY})`;
    const running = await tx.scrapeRun.findFirst({
      where: { status: 'RUNNING' },
      orderBy: { startedAt: 'desc' },
      select: { startedAt: true },
    });
    const decision = decideScrapeClaim({
      now: new Date(),
      runningStartedAt: running?.startedAt ?? null,
      staleAfterMs: SCRAPE_STALE_AFTER_MS,
    });
    if (decision === 'BUSY') throw new ScrapeBusyError('A scrape is already running (cross-process)');
    return tx.scrapeRun.create({ data: { trigger, status: 'RUNNING' } });
  });

  // Live progress (issue #40): persist the latest progress line into
  // ScrapeRun.message while the run is RUNNING. Throttled to one write per
  // PROGRESS_THROTTLE_MS with a trailing flush so the newest line always lands.
  // The final success/error message overwrites this — we never write progress
  // after the run is finalized. Each write is best-effort (a transient DB hiccup
  // updating progress must never fail an otherwise-good run).
  let lastWrite = 0;
  let pending: string | null = null;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let finalized = false;
  const writeProgress = (line: string): void => {
    if (finalized) return;
    void prisma.scrapeRun
      .updateMany({ where: { id: run.id, status: 'RUNNING' }, data: { message: line } })
      .catch(() => {});
  };
  const progress: ProgressFn = (msg) => {
    if (finalized) return;
    const line = formatProgressLine(msg);
    if (!line) return;
    const now = Date.now();
    if (now - lastWrite >= PROGRESS_THROTTLE_MS) {
      lastWrite = now;
      pending = null;
      writeProgress(line);
    } else {
      pending = line;
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          if (pending !== null) {
            lastWrite = Date.now();
            const l = pending;
            pending = null;
            writeProgress(l);
          }
        }, PROGRESS_THROTTLE_MS - (now - lastWrite));
      }
    }
  };

  const task = (async (): Promise<number> => {
    try {
      const result = await body(progress);
      // Stop live-progress writes before stamping the final summary so a trailing
      // flush can't overwrite it.
      finalized = true;
      if (flushTimer) clearTimeout(flushTimer);
      await prisma.scrapeRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCESS',
          finishedAt: new Date(),
          accountId: result.accountId,
          billsAdded: result.billsAdded,
          message: result.summaryMessage.slice(0, 500),
        },
      });
      return run.id;
    } catch (err: any) {
      finalized = true;
      if (flushTimer) clearTimeout(flushTimer);
      await prisma.scrapeRun.update({
        where: { id: run.id },
        data: { status: 'ERROR', finishedAt: new Date(), message: String(err?.message || err).slice(0, 500) },
      });
      throw err;
    } finally {
      finalized = true;
      if (flushTimer) clearTimeout(flushTimer);
      inFlight = null;
    }
  })();

  inFlight = task;
  // Surface the run id immediately; the task keeps running in the background.
  task.catch(() => {});
  return run.id;
}

// Re-throw ScrapeThrottledError so the runner can decide to throttle a portal
// tick. Kept exported for symmetry / potential reuse.
export function isThrottled(err: unknown): err is ScrapeThrottledError {
  return err instanceof ScrapeThrottledError;
}
