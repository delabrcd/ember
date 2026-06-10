import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { withAccount } from '@/lib/route';
import { PDF_PENDING_RECENT_DAYS } from '@/lib/scheduler/cadence';
import { projectTimeline, type ProjectionTaskInput } from '@/lib/scheduler/projection';
import type { TaskKind } from '@/lib/scheduler/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Read-only "upcoming scheduler actions for the next 7 days" surface
// (docs/scheduler-v2-plan.md §8). It loads THIS account's ScheduledTask rows,
// gathers each task's cadence facts impurely (the same facts the handlers/cadence
// use), then runs the PURE projectTimeline simulator. ADDITIVE + read-only: no
// scrape, no portal call, never returns a secret. Scopes to one account via the
// shared `withAccount`/resolveRequestAccount dance, exactly like /api/runs's
// siblings (interval/series/overview) — omitted ?accountId= = the default
// account, a bad id = 400. If V2 hasn't seeded tasks yet, returns { actions: [] }.
//
//   ?days=<n>   (default 7, clamped to 1..14) — the projection horizon.
//   ?accountId=<id>  — scopes to that account.
const DEFAULT_DAYS = 7;
const MIN_DAYS = 1;
const MAX_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

function parseDays(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return Math.min(MAX_DAYS, Math.max(MIN_DAYS, Math.floor(n)));
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const days = parseDays(params.get('days'));
  return withAccount(
    req.url,
    () => NextResponse.json({ actions: [], now: new Date().toISOString(), days }),
    async (acct) => {
      const accountId = acct.id;
      const now = new Date();

      const [tasks, bills, intervalCount, pendingPdfCount] = await Promise.all([
        prisma.scheduledTask.findMany({ where: { accountId } }),
        prisma.bill.findMany({ where: { accountId }, select: { statementDate: true } }),
        prisma.intervalUsage.count({ where: { accountId } }),
        prisma.bill.count({
          where: {
            accountId,
            pdfPath: null,
            statementDate: { gte: new Date(now.getTime() - PDF_PENDING_RECENT_DAYS * DAY_MS) },
          },
        }),
      ]);

      const statementDates = bills.map((b) => b.statementDate);
      const hasIntervalData = intervalCount > 0;
      const hasRecentPendingPdf = pendingPdfCount > 0;
      // hasAmiMeter proxy: we don't persist meter metadata (servicePointNumber /
      // hasAmiSmartMeter live only in the live gql payload), and this is a pure
      // read route that must NOT make a portal call. The honest proxy is "the
      // account already has interval rows" — only an AMI smart meter ever
      // produces IntervalUsage, so its presence implies an AMI meter. (A
      // brand-new AMI account before its first interval-pull reads false here;
      // the real interval-pull handler self-discovers the meter, so the
      // projection just under-promises until the first pull, never over-promises.)
      const hasAmiMeter = hasIntervalData;

      const inputs: ProjectionTaskInput[] = tasks.map((t) => ({
        kind: t.kind as TaskKind,
        enabled: t.enabled,
        nextRunAt: t.nextRunAt,
        facts: { statementDates, hasIntervalData, hasRecentPendingPdf, hasAmiMeter },
      }));

      const actions = projectTimeline(inputs, now, days).map((a) => ({
        kind: a.kind,
        at: a.at ? a.at.toISOString() : null,
        reason: a.reason,
      }));

      return NextResponse.json({ actions, now: now.toISOString(), days });
    }
  );
}
