// interval-pull handler — per-account AMI smart-meter interval capture (§5/§9b).
//
// interval-pull needs meter metadata (servicePointNumber / hasAmiSmartMeter) that
// lives ONLY in the live gql `billingAccount` payload, not the DB. So this handler
// does a LIGHT /dashboard?accountLink nav with a temporary response capture for
// the billingAccount payload (mirroring collect.ts's onDiscovery), then
// extractAmiMeters → fetchAmiIntervals → persist a partial CollectResult (only
// intervals). SAFETY NET: the AMI 22h cap STAYS on full-scrape this whole rollout
// (cadence.computeFullScrapeNextRun), so even a SKIPPED/weak interval-pull leaves
// interval capture continuous. Fully try/catch — never throws.
import { prisma } from '@/lib/db';
import { buildNavUrl } from '@/lib/ngrid/accounts';
import { extractAmiMeters } from '@/lib/ngrid/interval';
import { fetchAmiIntervals } from '@/lib/ngrid/portalFetch';
import { persist } from '@/lib/ngrid/persist';
import { computeIntervalNextRun } from '@/lib/scheduler/cadence';
import { errMessage } from '@/lib/ngrid/errMessage';
import { GQL_URL_RE } from '@/lib/ngrid/collectRaw';
import type { AccountInfo, CollectResult } from '@/lib/ngrid/types';
import type { TaskContext, TaskHandler, TaskResult } from '@/lib/scheduler/types';

const BASE = 'https://myaccount.nationalgrid.com';
const ERROR_BACKOFF_MS = 22 * 60 * 60 * 1000; // re-try ~daily on a hiccup

async function run(ctx: TaskContext): Promise<TaskResult> {
  const { session, now, log, task } = ctx;
  if (task.accountId == null) return { nextRunAt: null, status: 'SKIPPED', reason: 'no account' };
  if (!session) return { nextRunAt: null, status: 'ERROR', reason: 'no portal session' };

  const account = await prisma.account.findUnique({ where: { id: task.accountId } });
  if (!account) return { nextRunAt: null, status: 'SKIPPED', reason: 'account gone' };

  try {
    const authHeaders = await session.ensureAuthHeaders();

    // Light capture: nav to /dashboard for this account with a temporary response
    // handler grabbing the billingAccount gql payload (mirrors collect.ts:91-105's
    // onDiscovery + the data.billingAccount capture). One extra nav + the same 4s
    // settle — good guest.
    let rawAccount: unknown = null;
    const onResp = async (resp: import('playwright').Response) => {
      const url = resp.url();
      if (!GQL_URL_RE.test(url)) return;
      try {
        const json = (await resp.json()) as { data?: { billingAccount?: unknown } | null };
        if (json?.data?.billingAccount && !rawAccount) rawAccount = json.data.billingAccount;
      } catch {
        /* not JSON / not interesting */
      }
    };
    session.page.on('response', onResp);
    try {
      await session.page
        .goto(buildNavUrl(BASE, '/dashboard', account.accountLink ?? undefined), {
          waitUntil: 'networkidle',
          timeout: 30000,
        })
        .catch(() => {});
      await session.page.waitForTimeout(4000);
    } finally {
      session.page.off('response', onResp);
    }

    const meters = extractAmiMeters(rawAccount);
    if (!meters.length) {
      // No AMI meter (or the light capture didn't yield it). SKIP gracefully — the
      // full-scrape AMI cap is the safety net (it pulls intervals daily anyway).
      return {
        nextRunAt: computeIntervalNextRun(now, { hasAmiMeter: false }), // null
        status: 'SKIPPED',
        reason: rawAccount ? 'no AMI meter' : 'meter metadata unavailable (full-scrape AMI cap covers this)',
      };
    }

    const acct: AccountInfo = {
      accountNumber: account.accountNumber,
      accountLink: account.accountLink ?? undefined,
      region: account.region ?? undefined,
      companyCode: account.companyCode ?? undefined,
      serviceAddress: account.serviceAddress ?? undefined,
      fuelTypes: account.fuelTypes,
      premiseNumber: account.premiseNumber ?? undefined,
      customerNumber: account.customerNumber ?? undefined,
    };
    const intervals = await fetchAmiIntervals(session.ctx, session.page, {
      acct,
      rawAccount,
      authHeaders,
      haveAuth: true,
      accountNumber: account.accountNumber,
      hasIntervalData: async (accountNumber) => {
        const a = await prisma.account.findUnique({ where: { accountNumber }, select: { id: true } });
        if (!a) return false;
        return (await prisma.intervalUsage.count({ where: { accountId: a.id } })) > 0;
      },
      log,
    });

    const result: CollectResult = {
      account: acct,
      bills: [],
      usage: [],
      costs: [],
      weather: [],
      intervals,
      pdfsDownloaded: 0,
      loginId: account.loginId ?? undefined,
    };
    await persist(result);

    return {
      nextRunAt: computeIntervalNextRun(now, { hasAmiMeter: true }),
      status: 'SUCCESS',
      reason: `${intervals.length} interval row(s)`,
    };
  } catch (err: unknown) {
    return {
      nextRunAt: new Date(now.getTime() + ERROR_BACKOFF_MS),
      status: 'ERROR',
      reason: errMessage(err),
    };
  }
}

export const intervalPullHandler: TaskHandler = { kind: 'interval-pull', portal: true, run };
