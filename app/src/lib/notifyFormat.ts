// PURE new-bill notification helpers (issue #7) — message content, watermark
// dedupe, and channel resolution. No DB / network / I/O imports live here, so
// the unit suite can exercise these without a generated Prisma client. The
// impure dispatcher (send + AppSetting watermark advance) lives in `notify.ts`.

import { isoDate } from './ym';

export const LAST_NOTIFIED_KEY = 'lastNotifiedStatementDate';

export type NotifyChannel = 'off' | 'webhook' | 'ntfy' | 'smtp';

// A read-only string map of the env keys this module looks at. Broader than the
// strict NodeJS.ProcessEnv (which requires NODE_ENV) so it accepts process.env
// and plain test fixtures alike.
export type NotifyEnv = Record<string, string | undefined>;

// The bill fields a notification needs. A subset of the Prisma Bill row, kept
// minimal so the pure helpers don't depend on the DB model.
export interface NotifiableBill {
  statementDate: Date;
  periodFrom: Date | null;
  periodTo: Date | null;
  currentCharges: number | null;
}

export interface BillNotification {
  subject: string;
  body: string;
  link?: string;
  amount: number | null;
  statementDate: string; // YYYY-MM-DD
}

const fmtUsd = (n: number | null): string =>
  n == null ? 'n/a' : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Pure: message content ────────────────────────────────────────────────────
// A new-bill notification is a pure function of the bill (amount = currentCharges,
// the analysis-correct number per the golden rules — NOT totalDueAmount) plus an
// optional dashboard base URL. No env, no I/O.
export function formatBillNotification(bill: NotifiableBill, baseUrl?: string): BillNotification {
  const statementDate = isoDate(bill.statementDate);
  const amount = bill.currentCharges ?? null;
  const period =
    bill.periodFrom && bill.periodTo ? `${isoDate(bill.periodFrom)} → ${isoDate(bill.periodTo)}` : 'n/a';

  const subject = `New National Grid bill: ${fmtUsd(amount)} (statement ${statementDate})`;
  const link = baseUrl ? `${baseUrl.replace(/\/+$/, '')}/` : undefined;

  const lines = [
    `A new National Grid bill was scraped.`,
    ``,
    `Charges: ${fmtUsd(amount)}`,
    `Service period: ${period}`,
    `Statement date: ${statementDate}`,
  ];
  if (link) lines.push(``, `Dashboard: ${link}`);

  return { subject, body: lines.join('\n'), link, amount, statementDate };
}

// ── Pure: watermark dedupe selection ─────────────────────────────────────────
// Given the bills present after a scrape and the stored watermark (ISO date or
// null), decide which bills to notify and what the new watermark should be.
//   - watermark === null  → FIRST RUN: seed to the max statementDate, notify none.
//   - otherwise           → notify every bill strictly newer than the watermark,
//                           ordered oldest-first, and advance the watermark to the
//                           newest such bill (unchanged if nothing is newer).
// Strictly-newer (>) means re-running with no new bill notifies nobody.
export function selectBillsToNotify(
  bills: NotifiableBill[],
  watermark: string | null
): { toNotify: NotifiableBill[]; newWatermark: string | null } {
  if (bills.length === 0) return { toNotify: [], newWatermark: watermark };

  const sorted = [...bills].sort((a, b) => a.statementDate.getTime() - b.statementDate.getTime());
  const maxIso = isoDate(sorted[sorted.length - 1].statementDate);

  // First run: seed the watermark to the latest bill, notify nothing.
  if (watermark === null) return { toNotify: [], newWatermark: maxIso };

  const toNotify = sorted.filter((b) => isoDate(b.statementDate) > watermark);
  if (toNotify.length === 0) return { toNotify: [], newWatermark: watermark };

  const newWatermark = isoDate(toNotify[toNotify.length - 1].statementDate);
  return { toNotify, newWatermark };
}

// ── Pure: channel resolution ─────────────────────────────────────────────────
// Channel is NOTIFY_CHANNEL if set; otherwise inferred from which env is present
// (webhook > ntfy > smtp), else "off". Off by default.
export function resolveChannel(env: NotifyEnv = process.env): NotifyChannel {
  const explicit = (env.NOTIFY_CHANNEL || '').trim().toLowerCase();
  if (explicit === 'webhook' || explicit === 'ntfy' || explicit === 'smtp' || explicit === 'off') {
    return explicit;
  }
  if (explicit) return 'off'; // unrecognized value → off, never throw
  if (env.NOTIFY_WEBHOOK_URL) return 'webhook';
  if (env.NTFY_TOPIC) return 'ntfy';
  if (env.SMTP_HOST) return 'smtp';
  return 'off';
}
