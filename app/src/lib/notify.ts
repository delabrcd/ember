// New-bill notifications (issue #7). Off by default; a misconfigured or unset
// channel is a no-op and must NEVER throw into — or slow down — the scrape path.
//
// Two layers live here:
//   1. PURE, unit-tested helpers — formatBillNotification() (message content) and
//      selectBillsToNotify() (watermark dedupe). No DB / network / env.
//   2. An impure dispatcher — notifyNewBills() — that reads env, picks a channel,
//      sends, and advances the AppSetting watermark. Wrapped in try/catch by its
//      caller (run.ts) so a notification failure can't fail a good scrape.
//
// Dedupe is a watermark in the AppSetting table (key `lastNotifiedStatementDate`,
// an ISO YYYY-MM-DD). No schema change. We notify for each bill whose
// statementDate is strictly newer than the watermark, then advance the watermark
// to the newest notified date — exactly-once across restarts and multiple new
// bills per scrape. On first run (watermark unset) we seed it to the current max
// statementDate WITHOUT notifying, so configuring notifications never replays
// the whole bill history.
import nodemailer from 'nodemailer';
import { getSetting, setSetting } from '@/lib/settings';

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

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

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

// ── Impure: channel resolution + send ────────────────────────────────────────
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

async function sendWebhook(n: BillNotification, env: NotifyEnv): Promise<void> {
  const url = env.NOTIFY_WEBHOOK_URL;
  if (!url) throw new Error('NOTIFY_WEBHOOK_URL not set');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      event: 'new_bill',
      subject: n.subject,
      body: n.body,
      amount: n.amount,
      statementDate: n.statementDate,
      link: n.link ?? null,
    }),
  });
  if (!res.ok) throw new Error(`webhook ${res.status}`);
}

async function sendNtfy(n: BillNotification, env: NotifyEnv): Promise<void> {
  const base = (env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, '');
  const topic = env.NTFY_TOPIC;
  if (!topic) throw new Error('NTFY_TOPIC not set');
  const headers: Record<string, string> = { Title: n.subject };
  if (n.link) headers.Click = n.link;
  if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
  const res = await fetch(`${base}/${encodeURIComponent(topic)}`, { method: 'POST', headers, body: n.body });
  if (!res.ok) throw new Error(`ntfy ${res.status}`);
}

async function sendSmtp(n: BillNotification, env: NotifyEnv): Promise<void> {
  const host = env.SMTP_HOST;
  const to = env.SMTP_TO;
  const from = env.SMTP_FROM;
  if (!host || !to || !from) throw new Error('SMTP_HOST/SMTP_FROM/SMTP_TO required');
  const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : 587;
  // secure=true → implicit TLS (465). Default to true on 465, else honor SMTP_SECURE.
  const secure = env.SMTP_SECURE != null ? env.SMTP_SECURE === 'true' : port === 465;
  const auth = env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS || '' } : undefined;
  const transport = nodemailer.createTransport({ host, port, secure, auth });
  await transport.sendMail({ from, to, subject: n.subject, text: n.body });
}

async function dispatch(channel: NotifyChannel, n: BillNotification, env: NotifyEnv): Promise<void> {
  switch (channel) {
    case 'webhook':
      return sendWebhook(n, env);
    case 'ntfy':
      return sendNtfy(n, env);
    case 'smtp':
      return sendSmtp(n, env);
    case 'off':
      return; // no-op
  }
}

// ── Impure: the scrape-path entry point ──────────────────────────────────────
// Called by run.ts after a SCHEDULED scrape persists bills. Selects un-notified
// bills via the AppSetting watermark, sends one notification each on the active
// channel, then advances the watermark. Every failure mode (off channel, send
// error, watermark write) is contained: this never throws and never blocks the
// scrape. Returns a small summary for logging.
export async function notifyNewBills(
  bills: NotifiableBill[],
  log: (msg: string) => void = () => {},
  env: NotifyEnv = process.env
): Promise<{ sent: number; channel: NotifyChannel; seeded: boolean }> {
  const channel = resolveChannel(env);

  const watermarkRaw = await getSetting(LAST_NOTIFIED_KEY);
  const watermark = watermarkRaw ?? null;
  const { toNotify, newWatermark } = selectBillsToNotify(bills, watermark);

  // First run seeds the watermark even when the channel is off, so that turning
  // notifications on later doesn't replay the entire bill history.
  if (watermark === null && newWatermark != null) {
    await setSetting(LAST_NOTIFIED_KEY, newWatermark);
    log(`notify: seeded watermark to ${newWatermark} (no notifications on first run)`);
    return { sent: 0, channel, seeded: true };
  }

  if (channel === 'off') return { sent: 0, channel, seeded: false };
  if (toNotify.length === 0) return { sent: 0, channel, seeded: false };

  const baseUrl = env.APP_BASE_URL || undefined;
  let sent = 0;
  let highWater = watermark; // advance only past bills we actually delivered

  for (const bill of toNotify) {
    const n = formatBillNotification(bill, baseUrl);
    try {
      await dispatch(channel, n, env);
      sent += 1;
      highWater = n.statementDate;
    } catch (err: any) {
      // Stop at the first failure so the watermark doesn't skip an undelivered
      // bill — we'll retry it next scheduled scrape.
      log(`notify: ${channel} send failed for ${n.statementDate}: ${String(err?.message || err).slice(0, 200)}`);
      break;
    }
  }

  if (highWater !== watermark && highWater != null) {
    await setSetting(LAST_NOTIFIED_KEY, highWater);
  }
  if (sent > 0) log(`notify: sent ${sent} new-bill ${sent === 1 ? 'notification' : 'notifications'} via ${channel}`);
  return { sent, channel, seeded: false };
}
