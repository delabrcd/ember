import { NextResponse } from 'next/server';
import { withAccount, errorResponse } from '@/lib/route';
import { getSetting, setSetting } from '@/lib/settings';
import {
  DEFAULT_DASHBOARD_LAYOUT,
  isPlausibleLayout,
  mergeDashboardLayout,
} from '@/lib/dashboardLayout';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Server-side, per-account DASHBOARD LAYOUT (Phase D, issue #96; RFC §3.4 +
// Decision 4). The dashboard DEFINITION (chart order, per-chart config, chart
// visibility) lives in the DB so it follows the user across browsers/devices and
// is captured by the existing backup — replacing the per-browser localStorage
// half that owned it before.
//
// STORAGE — no schema change (RFC §3.4 preferred path). `AppSetting` is a GLOBAL
// key/value table; we get per-account scoping by NAMESPACING THE KEY with the
// resolved numeric account id (`withAccount` runs the existing default /
// ?accountId= resolution). A single-account install just uses its one id. No new
// row type, no Prisma migration.
//
// GATE: this route carries only layout CONFIG (no financial data), but it still
// inherits the app's existing access gate via `withAccount` and is NEVER public.
const layoutKey = (accountId: number) => `dashboard.layout:${accountId}`;

// GET → the saved layout for the account, or the default if none saved. Returns
// `{ layout, imported }`:
//   • `imported` = whether a server layout already EXISTS for this account. The
//     client uses it to gate the one-time localStorage→server import: it only
//     imports when imported=false (no server layout yet), so a later server edit
//     is never clobbered by a stale localStorage blob.
//   • When nothing is stored we return the DEFAULT layout (today's dashboard) so
//     a fresh account renders exactly as before — and imported=false so the
//     client may still import an existing v1 localStorage blob over it.
export async function GET(req: Request) {
  return withAccount(
    req.url,
    // No account yet (fresh install): the default layout, not yet imported.
    () => NextResponse.json({ layout: DEFAULT_DASHBOARD_LAYOUT, imported: false }),
    async (acct) => {
      try {
        const raw = await getSetting(layoutKey(acct.id));
        if (raw == null) {
          return NextResponse.json({ layout: DEFAULT_DASHBOARD_LAYOUT, imported: false });
        }
        // Repair on read: a saved blob written by an older app version (or a
        // partial one) is canonicalized through the same merge the client uses,
        // so the response is always a well-formed DashboardLayout.
        const parsed = JSON.parse(raw) as unknown;
        return NextResponse.json({ layout: mergeDashboardLayout(parsed), imported: true });
      } catch (e) {
        return errorResponse(e);
      }
    }
  );
}

// PUT → validate + store the layout JSON under the namespaced key. The body is
// defensively parse-guarded (gated, but still defend the parse + cap the size),
// then run through mergeDashboardLayout so what we persist is ALWAYS canonical —
// unknown chart ids dropped, new charts appended, missing config filled. We
// store the canonical form so a future read is cheap and consistent.
export async function PUT(req: Request) {
  const body = await req.json().catch(() => null);
  return withAccount(
    req.url,
    // No account to scope to: nothing to persist against.
    () => NextResponse.json({ error: 'no account' }, { status: 400 }),
    async (acct) => {
      try {
        if (!isPlausibleLayout(body)) {
          return NextResponse.json({ error: 'malformed layout' }, { status: 400 });
        }
        const layout = mergeDashboardLayout(body);
        await setSetting(layoutKey(acct.id), JSON.stringify(layout));
        return NextResponse.json({ layout, imported: true });
      } catch (e) {
        return errorResponse(e);
      }
    }
  );
}
