// pdf-fetch handler — targeted PDF top-up for one account (the live pain point:
// NG publishes a bill's statement row ~1-3 days before the downloadable PDF, so
// a new bill lands with pdfPath=null; this self-deactivating ~6h task fetches the
// lagging PDF promptly without idling on the bill-prediction back-off). §5.
//
// Reuses the extracted downloadBillPdfs helper (the same logic collect.ts:417
// runs) against the shared session's auth headers, then persists pdfPath +
// currentCharges + cost rows via a PARTIAL CollectResult (persist's `?? undefined`
// won't clobber, and empty arrays skip — clean targeted write, §9b).
import { prisma } from '@/lib/db';
import { downloadBillPdfs } from '@/lib/ngrid/portalFetch';
import { persist } from '@/lib/ngrid/persist';
import { computePdfFetchNextRun, PDF_PENDING_RECENT_DAYS } from '@/lib/scheduler/cadence';
import type { AccountInfo, BillRow, CollectResult } from '@/lib/ngrid/types';
import type { TaskContext, TaskHandler, TaskResult } from '@/lib/scheduler/types';

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

async function run(ctx: TaskContext): Promise<TaskResult> {
  const { session, now, log, task } = ctx;
  if (task.accountId == null) return { nextRunAt: null, status: 'SKIPPED', reason: 'no account' };
  if (!session) return { nextRunAt: null, status: 'ERROR', reason: 'no portal session' };

  const account = await prisma.account.findUnique({ where: { id: task.accountId } });
  if (!account) return { nextRunAt: null, status: 'SKIPPED', reason: 'account gone' };

  const pdfCutoff = new Date(now.getTime() - PDF_PENDING_RECENT_DAYS * 24 * 60 * 60 * 1000);
  const pending = await prisma.bill.findMany({
    where: { accountId: account.id, pdfPath: null, statementDate: { gte: pdfCutoff } },
    select: { statementDate: true, periodFrom: true, periodTo: true },
  });
  if (pending.length === 0) {
    // Self-deactivate — full-scrape re-arms us when a new pending bill appears.
    return { nextRunAt: null, status: 'SUCCESS', reason: 'no pending PDFs' };
  }

  try {
    const authHeaders = await session.ensureAuthHeaders();
    const bills: BillRow[] = pending.map((b) => ({
      statementDate: ymd(b.statementDate),
      periodFrom: b.periodFrom ? ymd(b.periodFrom) : undefined,
      periodTo: b.periodTo ? ymd(b.periodTo) : undefined,
      usageTypes: [],
    }));
    // downloadBillPdfs MUTATES `bills` in place (sets pdfPath/currentCharges) and
    // returns the per-fuel cost rows — same as inside collect().
    const pdf = await downloadBillPdfs(session.ctx, session.page, {
      accountNumber: account.accountNumber,
      authHeaders,
      bills,
      log,
    });

    // Map the DB Account row → AccountInfo and persist a PARTIAL CollectResult:
    // only the now-updated bills + cost rows; usage/weather/intervals empty so
    // persist() leaves them untouched.
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
    const result: CollectResult = {
      account: acct,
      bills,
      usage: [],
      costs: pdf.costRows,
      weather: [],
      intervals: [],
      pdfsDownloaded: pdf.pdfsDownloaded,
      loginId: account.loginId ?? undefined,
    };
    await persist(result);
  } catch (err: any) {
    // Never throw — re-check on the next short cadence (still pending).
    return {
      nextRunAt: computePdfFetchNextRun(now, { hasRecentPendingPdf: true }),
      status: 'ERROR',
      reason: String(err?.message || err).slice(0, 200),
    };
  }

  // Recount after the write: still pending → ~6h; cleared → null (deactivate).
  const stillPending = await prisma.bill.count({
    where: { accountId: account.id, pdfPath: null, statementDate: { gte: pdfCutoff } },
  });
  return {
    nextRunAt: computePdfFetchNextRun(now, { hasRecentPendingPdf: stillPending > 0 }),
    status: 'SUCCESS',
    reason: stillPending > 0 ? `${stillPending} PDF(s) still pending` : 'PDFs fetched',
  };
}

export const pdfFetchHandler: TaskHandler = { kind: 'pdf-fetch', portal: true, run };
