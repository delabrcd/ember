// Orchestrates a single scrape: guard → record run → collect → persist →
// update schedule prediction → finalize run. Safe to call from the API route
// (manual button) and the scheduler.
import { prisma } from '@/lib/db';
import { computeNextCheck, predictNextBill } from '@/lib/prediction';
import { syncHistoricalWeather } from '@/lib/weather/sync';
import { collect } from './collect';
import { persist } from './persist';
import type { ProgressFn } from './types';

const MIN_SCHEDULED_GAP_MS = 5 * 60 * 1000; // don't auto-scrape more often than this
let inFlight: Promise<number> | null = null; // in-process concurrency guard

export class ScrapeBusyError extends Error {}
export class ScrapeThrottledError extends Error {}

async function updateSchedule(accountId: number): Promise<void> {
  const bills = await prisma.bill.findMany({
    where: { accountId },
    select: { statementDate: true },
  });
  const { predicted } = predictNextBill(bills.map((b) => b.statementDate));
  const now = new Date();
  const nextCheckAt = computeNextCheck(now, predicted);
  await prisma.scheduleState.upsert({
    where: { accountId },
    create: { accountId, predictedNextBillDate: predicted, nextCheckAt, lastCheckedAt: now },
    update: { predictedNextBillDate: predicted, nextCheckAt, lastCheckedAt: now },
  });
}

// Returns the ScrapeRun id. Throws ScrapeBusyError / ScrapeThrottledError when skipped.
export async function runScrape(
  trigger: 'MANUAL' | 'SCHEDULED',
  log: ProgressFn = () => {}
): Promise<number> {
  if (inFlight) throw new ScrapeBusyError('A scrape is already running');

  if (trigger === 'SCHEDULED') {
    const last = await prisma.scrapeRun.findFirst({
      where: { status: 'SUCCESS' },
      orderBy: { startedAt: 'desc' },
    });
    if (last && Date.now() - last.startedAt.getTime() < MIN_SCHEDULED_GAP_MS) {
      throw new ScrapeThrottledError('Scraped too recently');
    }
  }

  const run = await prisma.scrapeRun.create({ data: { trigger, status: 'RUNNING' } });

  const task = (async (): Promise<number> => {
    try {
      const result = await collect((m) => {
        log(m);
      });
      const summary = await persist(result);
      await updateSchedule(summary.accountId);
      // Pull full-history daily temps from Open-Meteo (NG's feed is ~24 mo only).
      // Non-fatal: a weather hiccup must not fail an otherwise-good scrape.
      try {
        const w = await syncHistoricalWeather(summary.accountId);
        log(`weather: ${w.dailyUpserted} daily, ${w.monthsUpserted} monthly${w.skipped ? ` (${w.skipped})` : ''}`);
      } catch (werr: any) {
        log(`weather sync skipped: ${String(werr?.message || werr).slice(0, 200)}`);
      }
      await prisma.scrapeRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCESS',
          finishedAt: new Date(),
          accountId: summary.accountId,
          billsAdded: summary.billsAdded,
          message: `${summary.billsTotal} bills (${summary.billsAdded} new), ${result.pdfsDownloaded} PDFs fetched`,
        },
      });
      return run.id;
    } catch (err: any) {
      await prisma.scrapeRun.update({
        where: { id: run.id },
        data: { status: 'ERROR', finishedAt: new Date(), message: String(err?.message || err).slice(0, 500) },
      });
      throw err;
    } finally {
      inFlight = null;
    }
  })();

  inFlight = task;
  // Surface the run id immediately; the task keeps running in the background.
  // Callers that want to wait can await getRun(runId) polling.
  task.catch(() => {});
  return run.id;
}

export function isScraping(): boolean {
  return inFlight !== null;
}
