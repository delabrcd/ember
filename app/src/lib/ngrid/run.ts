// Orchestrates a single scrape: guard → record run → collect → persist →
// update schedule prediction → finalize run. Safe to call from the API route
// (manual button) and the scheduler.
import { prisma } from '@/lib/db';
import { computeNextCheck, predictNextBill } from '@/lib/prediction';
import { syncHistoricalWeather } from '@/lib/weather/sync';
import { notifyNewBills } from '@/lib/notify';
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
      // Scrape each stored NgLogin sequentially (good-guest: one session at a
      // time, never parallel logins). When there are no NgLogin rows we make a
      // single env-credential pass — collect()'s auth layer resolves env creds —
      // which preserves the original single-login behavior exactly.
      const logins = await prisma.ngLogin.findMany({ orderBy: { id: 'asc' } });
      const passes: { loginId?: number }[] = logins.length
        ? logins.map((l) => ({ loginId: l.id }))
        : [{}];

      let totalBills = 0;
      let totalNew = 0;
      let totalPdfs = 0;
      let accountCount = 0;
      let firstAccountId: number | undefined;
      const scrapedAccountIds = new Set<number>();

      for (const pass of passes) {
        // collect() logs in (resolveCredsForLogin when a loginId is given, else
        // env via resolveCreds), discovers every billing account on that login,
        // and returns one result per account.
        const results = await collect((m) => log(m), { loginId: pass.loginId });
        for (const result of results) {
          const summary = await persist(result);
          await updateSchedule(summary.accountId);
          // Pull full-history daily temps from Open-Meteo (NG's feed is ~24 mo
          // only). Non-fatal: a weather hiccup must not fail a good scrape.
          try {
            const w = await syncHistoricalWeather(summary.accountId);
            log(`weather: ${w.dailyUpserted} daily, ${w.monthsUpserted} monthly${w.skipped ? ` (${w.skipped})` : ''}`);
          } catch (werr: any) {
            log(`weather sync skipped: ${String(werr?.message || werr).slice(0, 200)}`);
          }
          totalBills += summary.billsTotal;
          totalNew += summary.billsAdded;
          totalPdfs += result.pdfsDownloaded;
          accountCount += 1;
          scrapedAccountIds.add(summary.accountId);
          if (firstAccountId === undefined) firstAccountId = summary.accountId;
        }
      }

      // New-bill notifications (issue #7). SCHEDULED-only by default: manual
      // refreshes stay silent. Dedupe + first-run seeding are handled inside
      // notifyNewBills via the AppSetting watermark. Fully contained — a
      // notification problem must never fail or slow a successful scrape.
      if (trigger === 'SCHEDULED' && scrapedAccountIds.size > 0) {
        try {
          const bills = await prisma.bill.findMany({
            where: { accountId: { in: [...scrapedAccountIds] } },
            select: { statementDate: true, periodFrom: true, periodTo: true, currentCharges: true },
          });
          await notifyNewBills(bills, (m) => log(m));
        } catch (nerr: any) {
          log(`notify skipped: ${String(nerr?.message || nerr).slice(0, 200)}`);
        }
      }

      await prisma.scrapeRun.update({
        where: { id: run.id },
        data: {
          status: 'SUCCESS',
          finishedAt: new Date(),
          // ScrapeRun tracks one account; record the first scraped account so the
          // single-account case is unchanged. (Per-account audit is a later step.)
          accountId: firstAccountId,
          billsAdded: totalNew,
          message: `${accountCount} account(s): ${totalBills} bills (${totalNew} new), ${totalPdfs} PDFs fetched`,
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
