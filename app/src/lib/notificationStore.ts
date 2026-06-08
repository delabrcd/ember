// Impure server-side store for the notification log (notification-log feature).
//
// The PURE derivation (which rows should exist for an account) lives in
// deriveNotifications (notifications.ts); this module is the DB side: it computes
// those rows from the account's bills + current anomalies and idempotently upserts
// them, lists them for the bell, and marks them read. Kept out of the pure module
// so the unit suite stays hermetic.
//
// IDEMPOTENCY / READ-STATE PRESERVATION. syncNotifications is safe to call on
// every GET and after every scheduled scrape: it INSERTs only the rows that don't
// yet exist (by the @@unique([accountId, key])) and NEVER touches an existing
// row's readAt or createdAt — so backfilling history or re-syncing can't resurrect
// a read item as unread or reorder the log. We use createMany({ skipDuplicates })
// rather than an upsert-with-update precisely so a conflict is a no-op.

import { prisma } from '@/lib/db';
import { getBills, getMonthlySeries } from '@/lib/queries';
import { detectAnomalies } from '@/lib/anomaly';
import { deriveNotifications, type NotificationRow } from '@/lib/notifications';
import type { Prisma } from '@prisma/client';

// One log row as the bell consumes it (client-safe; no secret). `payload` is the
// stored JSON the detail modal renders (the AnomalyFlag or the bill summary).
export interface NotificationLogItem {
  id: number;
  kind: string; // 'bill' | 'anomaly'
  key: string;
  title: string;
  message: string;
  payload: unknown;
  createdAt: string; // ISO
  readAt: string | null; // ISO or null (= unread)
}

// Compute the rows that should exist for this account (full bill history + current
// anomaly flags) and INSERT any that are missing. Existing rows are left untouched
// — read/unread and createdAt are preserved (createMany skipDuplicates). Returns
// the number of newly-inserted rows. Failure-tolerant callers wrap this in
// try/catch; it does not swallow its own errors.
export async function syncNotifications(accountId: number): Promise<number> {
  const [bills, series] = await Promise.all([getBills(accountId), getMonthlySeries(accountId)]);
  const { flags } = detectAnomalies(series);
  const rows: NotificationRow[] = deriveNotifications(bills, flags, accountId);
  if (rows.length === 0) return 0;

  const result = await prisma.notification.createMany({
    data: rows.map((r) => ({
      accountId: r.accountId,
      kind: r.kind,
      key: r.key,
      title: r.title,
      message: r.message,
      // payload is plain JSON-safe data (bill summary or AnomalyFlag).
      payload: r.payload as unknown as Prisma.InputJsonValue,
    })),
    skipDuplicates: true, // a (accountId, key) conflict is a no-op — never overwrites readAt/createdAt
  });
  return result.count;
}

// List an account's notifications newest-first, plus the unread count (readAt
// null). Client-safe shaping (ISO dates); the stored payload passes through for
// the detail modal.
export async function listNotifications(
  accountId: number
): Promise<{ notifications: NotificationLogItem[]; unreadCount: number }> {
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { accountId },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.notification.count({ where: { accountId, readAt: null } }),
  ]);
  return {
    notifications: rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      key: n.key,
      title: n.title,
      message: n.message,
      payload: n.payload,
      createdAt: n.createdAt.toISOString(),
      readAt: n.readAt ? n.readAt.toISOString() : null,
    })),
    unreadCount,
  };
}

// Mark notifications read: one by its stable key, or all of the account's unread
// ones. Only flips currently-unread rows (readAt null) so a re-mark can't move an
// already-read item's timestamp. Returns the resulting unread count.
export async function markRead(
  accountId: number,
  target: { key: string } | { all: true }
): Promise<{ unreadCount: number }> {
  const where: Prisma.NotificationWhereInput = { accountId, readAt: null };
  if ('key' in target) where.key = target.key;
  await prisma.notification.updateMany({ where, data: { readAt: new Date() } });
  const unreadCount = await prisma.notification.count({ where: { accountId, readAt: null } });
  return { unreadCount };
}
