// Orchestrates a single scrape: guard → record run → collect → persist →
// update schedule prediction → finalize run. Safe to call from the API route
// (manual button) and the scheduler.
import { prisma } from '@/lib/db';
import { computeNextCheck, predictNextBill } from '@/lib/prediction';
import { syncHistoricalWeather } from '@/lib/weather/sync';
import { notifyNewBills } from '@/lib/notify';
import { collect } from './collect';
import { persist } from './persist';
import { classifyLoginError, shouldSkipScheduled, statusOnSuccess } from './loginStatus';
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
  const statementDates = bills.map((b) => b.statementDate);
  const { predicted } = predictNextBill(statementDates);
  const now = new Date();
  // Strong back-off (issue #27): idle until we near the predicted next-bill
  // date, then daily inside a window sized from historical gap variability.
  // We persist only predicted + nextCheckAt (no schema change); the window is
  // recomputed from statement history each run.
  const nextCheckAt = computeNextCheck(now, predicted, { statementDates });
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
      const allLogins = await prisma.ngLogin.findMany({ orderBy: { id: 'asc' } });
      // Good-guest: scheduled scrapes skip logins already flagged needs_reauth so
      // we don't hammer known-bad credentials. Manual re-auth (the UI) is the way
      // back. MANUAL runs still attempt every login (the operator asked for it).
      const logins =
        trigger === 'SCHEDULED' ? allLogins.filter((l) => !shouldSkipScheduled(l.status)) : allLogins;
      for (const l of allLogins) {
        if (trigger === 'SCHEDULED' && shouldSkipScheduled(l.status)) {
          log(`skipping login "${l.label}" (needs re-authentication)`);
        }
      }
      const passes: { loginId?: number }[] = logins.length
        ? logins.map((l) => ({ loginId: l.id }))
        : allLogins.length
          ? [] // logins exist but all are paused — nothing to do this run
          : [{}]; // no stored logins at all → single env-credential pass

      let totalBills = 0;
      let totalNew = 0;
      let totalPdfs = 0;
      let accountCount = 0;
      let firstAccountId: number | undefined;
      let skippedLogins = 0;
      const scrapedAccountIds = new Set<number>();

      for (const pass of passes) {
        // collect() logs in (resolveCredsForLogin when a loginId is given, else
        // env via resolveCreds), discovers every billing account on that login,
        // and returns one result per account.
        let results;
        try {
          results = await collect((m) => log(m), { loginId: pass.loginId });
        } catch (loginErr: any) {
          const msg = String(loginErr?.message || loginErr);
          const cls = classifyLoginError(msg);
          // A hard auth failure (wrong/disabled password, or an MFA step the
          // unattended path can't complete) flips THIS login to needs_reauth and
          // skips it gracefully — we never crash the whole scrape or touch its
          // existing data. Env-cred passes have no NgLogin row to flag, and any
          // non-auth error (network/portal hiccup) still propagates so the run is
          // recorded as ERROR (status untouched — a flaky run isn't a bad login).
          if (cls.isAuthFailure && pass.loginId !== undefined) {
            await prisma.ngLogin.update({
              where: { id: pass.loginId },
              data: { status: 'needs_reauth', lastVerifiedAt: undefined },
            });
            log(`login ${pass.loginId} needs re-authentication: ${cls.reason} — skipping it`);
            skippedLogins += 1;
            continue;
          }
          throw loginErr;
        }

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

        // A login that scraped at least one account is healthy: clear any prior
        // needs_reauth flag and stamp it verified. (Env passes have no id.)
        if (pass.loginId !== undefined && results.length > 0) {
          await prisma.ngLogin.update({
            where: { id: pass.loginId },
            data: { status: statusOnSuccess(), lastVerifiedAt: new Date() },
          });
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
          message:
            `${accountCount} account(s): ${totalBills} bills (${totalNew} new), ${totalPdfs} PDFs fetched` +
            (skippedLogins ? `; ${skippedLogins} login(s) need re-authentication` : ''),
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
