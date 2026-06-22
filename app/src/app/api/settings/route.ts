import { NextResponse } from 'next/server';
import { getDefaultAccount, getAccountMeta } from '@/lib/queries';
import { getNotifyStatus, getSetting, isSchedulerEnabled, setSetting } from '@/lib/settings';
import { resolveGridFactor } from '@/lib/emissions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const acct = await getDefaultAccount();
  // Settings needs only ~5 scalars (schedule/account/billCount/firstStatement/
  // latestBill) — getAccountMeta fetches exactly those (issue #154), avoiding the
  // full series/Kalman/projection/anomaly/budget pipeline getOverview would run.
  const overview = acct ? await getAccountMeta(acct.id) : null;
  // Carbon estimate grid factor (issue #49): the raw override the user has set
  // (empty when unset) plus the effective factor actually in use, so the Settings
  // UI can show what the estimate currently runs on (region default vs override).
  const gridEmissionFactor = (await getSetting('gridEmissionFactor')) ?? '';
  const effectiveGridFactor = resolveGridFactor(overview?.account?.region, gridEmissionFactor);
  // Budget / annual-spend target (issue #46): the raw target the user has set
  // (empty when unset) so the Settings UI can show + edit it.
  const budgetTarget = (await getSetting('budgetTarget')) ?? '';
  // Anomaly alert on a flagged new bill (issue #45): OFF by default. The boolean
  // toggle reuses the existing new-bill notification channel; it only sends when a
  // channel is configured AND this is on.
  const anomalyNotifyEnabled = (await getSetting('anomalyNotifyEnabled')) === 'true';
  return NextResponse.json({
    schedulerEnabled: await isSchedulerEnabled(),
    notify: await getNotifyStatus(),
    schedule: overview?.schedule ?? null,
    account: overview?.account ?? null,
    billCount: overview?.billCount ?? 0,
    firstStatement: overview?.firstStatement ?? null,
    latestBill: overview?.latestBill ?? null,
    gridEmissionFactor,
    effectiveGridFactor,
    budgetTarget,
    anomalyNotifyEnabled,
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (typeof body.schedulerEnabled === 'boolean') {
    await setSetting('schedulerEnabled', String(body.schedulerEnabled));
  }
  // Carbon estimate grid-factor override (issue #49), kg CO2e/kWh. An empty string
  // clears the override (the estimate reverts to the region's eGRID default); any
  // other value is validated as a positive finite number before it's stored, so a
  // bad input can never poison the estimate.
  if (typeof body.gridEmissionFactor === 'string') {
    const raw = body.gridEmissionFactor.trim();
    if (raw === '') {
      await setSetting('gridEmissionFactor', '');
    } else {
      const n = Number.parseFloat(raw);
      if (Number.isFinite(n) && n > 0) await setSetting('gridEmissionFactor', String(n));
    }
  }
  // Budget / annual-spend target (issue #46), dollars. An empty string clears the
  // target (the budget card disappears); any other value is validated as a positive
  // finite number before it's stored, so a bad input can never poison the projection.
  if (typeof body.budgetTarget === 'string') {
    const raw = body.budgetTarget.trim();
    if (raw === '') {
      await setSetting('budgetTarget', '');
    } else {
      const n = Number.parseFloat(raw);
      if (Number.isFinite(n) && n > 0) await setSetting('budgetTarget', String(n));
    }
  }
  // Anomaly alert toggle (issue #45). OFF by default; a plain boolean stored as a
  // string, like schedulerEnabled. Reuses the configured notification channel.
  if (typeof body.anomalyNotifyEnabled === 'boolean') {
    await setSetting('anomalyNotifyEnabled', String(body.anomalyNotifyEnabled));
  }
  const gridEmissionFactor = (await getSetting('gridEmissionFactor')) ?? '';
  const budgetTarget = (await getSetting('budgetTarget')) ?? '';
  const anomalyNotifyEnabled = (await getSetting('anomalyNotifyEnabled')) === 'true';
  return NextResponse.json({
    schedulerEnabled: await isSchedulerEnabled(),
    gridEmissionFactor,
    budgetTarget,
    anomalyNotifyEnabled,
  });
}
