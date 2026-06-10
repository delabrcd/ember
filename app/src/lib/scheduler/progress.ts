// Scheduler V2 audit + live-progress + in-flight-lock wrapper.
//
// This is a DELIBERATE DUPLICATE of the ScrapeRun audit row + throttled
// live-progress writer + finalize logic that lives inline in
// lib/ngrid/run.ts (the byte-for-byte-frozen legacy monolith). The runner
// (runner.ts) wraps a whole tick in this so the UI's ScrapeRun mirror, the
// /api/refresh/[id] live progress, and the manual/scheduled mutual exclusion
// all behave EXACTLY as the legacy path. We copy rather than import so run.ts
// stays untouched during the flag-gated rollout (step 7 deletes the old copy).
//
// The ScrapeBusyError / ScrapeThrottledError classes are IMPORTED from run.ts
// (not re-declared) so the refresh route's `instanceof` checks keep working
// across both code paths — those classes are stable.
import { prisma } from '@/lib/db';
import { formatProgressLine } from '@/lib/ngrid/progress';
import { ScrapeBusyError, ScrapeThrottledError } from '@/lib/ngrid/run';
import type { ProgressFn } from '@/lib/ngrid/types';

export { ScrapeBusyError, ScrapeThrottledError };

// Don't write a live-progress update to the DB more often than this (copied from
// run.ts:36). Bursty steps collapse to one write per window; the trailing edge
// always flushes the latest line.
const PROGRESS_THROTTLE_MS = 1000;

// Generalized in-flight guard (generalizes run.ts:37). A single module-level lock
// governs the V2 path: a manual run and a scheduled tick can never double-run —
// the second to arrive throws ScrapeBusyError. Cleared in the finally below.
let inFlight: Promise<number> | null = null;

export interface RunBodyResult {
  summaryMessage: string;
  billsAdded: number;
  accountId?: number;
}

// Wrap a unit of work in a ScrapeRun audit row with the throttled live-progress
// writer, exactly as run.ts does. Creates the row (RUNNING), builds the
// throttled `progress` ProgressFn, runs `body(progress)`, then finalizes SUCCESS
// (with the returned summary) or ERROR. Returns the ScrapeRun id immediately; the
// body keeps running in the background (the legacy contract — callers poll
// /api/refresh/[id]). Throws ScrapeBusyError if a run is already in flight.
export async function runWithScrapeRun(
  trigger: 'MANUAL' | 'SCHEDULED',
  body: (progress: ProgressFn) => Promise<RunBodyResult>
): Promise<number> {
  if (inFlight) throw new ScrapeBusyError('A scrape is already running');

  const run = await prisma.scrapeRun.create({ data: { trigger, status: 'RUNNING' } });

  // Live progress (issue #40): persist the latest progress line into
  // ScrapeRun.message while the run is RUNNING. Throttled to one write per
  // PROGRESS_THROTTLE_MS with a trailing flush so the newest line always lands.
  // The final success/error message overwrites this — we never write progress
  // after the run is finalized. Each write is best-effort (a transient DB hiccup
  // updating progress must never fail an otherwise-good run). Copied verbatim
  // from run.ts:111-146.
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
      // flush can't overwrite it (run.ts:296-299).
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
// tick the same way run.ts does. Kept exported for symmetry / potential reuse.
export function isThrottled(err: unknown): err is ScrapeThrottledError {
  return err instanceof ScrapeThrottledError;
}
