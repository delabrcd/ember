// notify-sync handler (non-portal) — the run.ts:253-293 post-pass scoped to one
// account: new-bill notifications + usage/cost anomaly alert + server-side
// notification-log sync. Each step is independently try/caught (contained — a
// notification problem must never fail or slow the tick). Reactive one-shot:
// armed by full-scrape ONLY on a SCHEDULED tick (a manual refresh stays silent),
// so the handler need not re-check trigger — but the guard is cheap insurance.
import { prisma } from '@/lib/db';
import { notifyNewBills, notifyAnomaly } from '@/lib/notify';
import { detectAnomalies } from '@/lib/anomaly';
import { getMonthlySeries } from '@/lib/queries';
import { syncNotifications } from '@/lib/notificationStore';
import type { TaskContext, TaskHandler, TaskResult } from '@/lib/scheduler/types';

async function run(ctx: TaskContext): Promise<TaskResult> {
  const { task, log, trigger } = ctx;
  if (task.accountId == null) return { nextRunAt: null, status: 'SKIPPED', reason: 'no account' };
  // notify-sync is armed only on SCHEDULED, but double-check so a stray manual arm
  // can never make a manual refresh chatter (matches run.ts:253's guard).
  if (trigger !== 'SCHEDULED') return { nextRunAt: null, status: 'SKIPPED', reason: 'manual run stays silent' };

  const accountId = task.accountId;

  // New-bill notifications (issue #7). Dedupe + first-run seeding handled inside
  // notifyNewBills via the AppSetting watermark. Fully contained.
  try {
    const bills = await prisma.bill.findMany({
      where: { accountId },
      select: { statementDate: true, periodFrom: true, periodTo: true, currentCharges: true },
    });
    await notifyNewBills(bills, (m) => log(m));
  } catch (nerr: any) {
    log(`notify skipped: ${String(nerr?.message || nerr).slice(0, 200)}`);
  }

  // Usage/cost anomaly alert (issue #45). OFF by default and dedup-safe. Fully
  // contained: never fails the tick.
  try {
    const series = await getMonthlySeries(accountId);
    const { flags, ym } = detectAnomalies(series);
    await notifyAnomaly(flags, ym, (m) => log(m));
  } catch (aerr: any) {
    log(`anomaly notify skipped: ${String(aerr?.message || aerr).slice(0, 200)}`);
  }

  // Server-side notification log (notification-log feature). Idempotent INSERTs.
  // Fully contained.
  try {
    const inserted = await syncNotifications(accountId);
    if (inserted) log(`notification log: ${inserted} new`);
  } catch (lerr: any) {
    log(`notification log skipped: ${String(lerr?.message || lerr).slice(0, 200)}`);
  }

  return { nextRunAt: null, status: 'SUCCESS' };
}

export const notifySyncHandler: TaskHandler = { kind: 'notify-sync', portal: false, run };
