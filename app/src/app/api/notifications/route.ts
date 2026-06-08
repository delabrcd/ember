import { NextResponse } from 'next/server';
import { listNotifications, markRead, syncNotifications } from '@/lib/notificationStore';
import { withAccount, errorResponse } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Server-side notification log (notification-log feature). Inherits the app's
// existing access gate (no new auth): a read GET that also backfills the log, and
// a mark-read mutation. ?accountId= scopes to that account; omitted = default.

// GET — sync the log (idempotent backfill of history + current anomalies) then
// return it newest-first with the unread count.
export async function GET(req: Request) {
  return withAccount(
    req.url,
    () => NextResponse.json({ notifications: [], unreadCount: 0 }),
    async (acct) => {
      // Best-effort sync: a sync hiccup must never block reading the existing log.
      try {
        await syncNotifications(acct.id);
      } catch {
        /* ignore — return whatever's already stored */
      }
      return NextResponse.json(await listNotifications(acct.id));
    }
  );
}

// POST — mark read: body { key } marks one, body { all: true } marks all. Returns
// the updated { unreadCount }.
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  return withAccount(
    req.url,
    () => NextResponse.json({ unreadCount: 0 }),
    async (acct) => {
      try {
        if (body?.all === true) {
          return NextResponse.json(await markRead(acct.id, { all: true }));
        }
        if (typeof body?.key === 'string' && body.key) {
          return NextResponse.json(await markRead(acct.id, { key: body.key }));
        }
        return NextResponse.json({ error: 'expected { key } or { all: true }' }, { status: 400 });
      } catch (e) {
        return errorResponse(e);
      }
    }
  );
}
