import { NextResponse } from 'next/server';
import { getDefaultAccount, getOverview } from '@/lib/queries';
import { getNotifyStatus, isSchedulerEnabled, setSetting } from '@/lib/settings';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  const acct = await getDefaultAccount();
  const overview = acct ? await getOverview(acct.id) : null;
  return NextResponse.json({
    schedulerEnabled: await isSchedulerEnabled(),
    notify: await getNotifyStatus(),
    schedule: overview?.schedule ?? null,
    account: overview?.account ?? null,
    billCount: overview?.billCount ?? 0,
    firstStatement: overview?.firstStatement ?? null,
    latestBill: overview?.latestBill ?? null,
  });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (typeof body.schedulerEnabled === 'boolean') {
    await setSetting('schedulerEnabled', String(body.schedulerEnabled));
  }
  return NextResponse.json({ schedulerEnabled: await isSchedulerEnabled() });
}
