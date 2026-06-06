// Runtime app settings, stored in the AppSetting key/value table. A DB value
// overrides the environment default.
import { prisma } from '@/lib/db';

export async function getSetting(key: string): Promise<string | null> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function isSchedulerEnabled(): Promise<boolean> {
  const v = await getSetting('schedulerEnabled');
  if (v === 'true') return true;
  if (v === 'false') return false;
  return process.env.SCHEDULER_ENABLED !== 'false';
}

// Read-only summary of the new-bill notification config (issue #7) for the
// Settings UI. Notifications are env-configured and off by default.
export async function getNotifyStatus(): Promise<{ channel: string; configured: boolean; lastNotifiedStatementDate: string | null }> {
  const { resolveChannel, LAST_NOTIFIED_KEY } = await import('@/lib/notifyFormat');
  const channel = resolveChannel();
  const lastNotifiedStatementDate = await getSetting(LAST_NOTIFIED_KEY);
  return { channel, configured: channel !== 'off', lastNotifiedStatementDate };
}
