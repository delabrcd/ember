// New-bill notifications (issue #7). Off by default; a misconfigured or unset
// channel is a no-op and must NEVER throw into — or slow down — the scrape path.
//
// Two layers:
//   1. PURE, unit-tested helpers — formatBillNotification() (message content),
//      selectBillsToNotify() (watermark dedupe) and resolveChannel() (env →
//      channel). They live in `@/lib/notifyFormat` (no DB / network / env imports);
//      this module imports them for the dispatcher below, and other callers/tests
//      import them from `@/lib/notifyFormat` directly. Keeping them DB-free lets the
//      unit suite run without a generated Prisma client.
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
import type { AnomalyFlag } from '@/lib/anomaly';
import {
  LAST_NOTIFIED_KEY,
  ANOMALY_NOTIFY_ENABLED_KEY,
  LAST_ANOMALY_NOTIFIED_KEY,
  formatBillNotification,
  formatAnomalyNotification,
  resolveChannel,
  selectBillsToNotify,
  shouldNotifyAnomaly,
  type BillNotification,
  type NotifiableBill,
  type NotifyChannel,
  type NotifyEnv,
} from '@/lib/notifyFormat';

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

// ── Impure: anomaly alert on a flagged new bill (issue #45) ───────────────────
// Called by run.ts after a SCHEDULED scrape, alongside notifyNewBills. OFF by
// default (gated on the anomalyNotifyEnabled AppSetting) and dedup-safe (a YYYYMM
// watermark in lastAnomalyNotifiedYm), so an anomaly alert sends at most once per
// flagged period across restarts. Like notifyNewBills it seeds the watermark on
// first run WITHOUT notifying, and is fully contained — every failure mode is
// caught so it can never fail or slow a good scrape. Returns a small summary.
export async function notifyAnomaly(
  flags: AnomalyFlag[],
  ym: number | null,
  log: (msg: string) => void = () => {},
  env: NotifyEnv = process.env
): Promise<{ sent: boolean; channel: NotifyChannel; seeded: boolean }> {
  const channel = resolveChannel(env);

  // Dedupe watermark first, so first-run seeding happens regardless of the toggle
  // — turning the feature on later never replays an already-present anomaly.
  const watermark = (await getSetting(LAST_ANOMALY_NOTIFIED_KEY)) ?? null;
  const flaggedYm = flags.length ? ym : null; // only a real flag advances the watermark
  const { notify, newWatermark } = shouldNotifyAnomaly(flaggedYm, watermark);

  if (watermark === null && newWatermark != null) {
    await setSetting(LAST_ANOMALY_NOTIFIED_KEY, newWatermark);
    log(`notify(anomaly): seeded watermark to ${newWatermark} (no notification on first run)`);
    return { sent: false, channel, seeded: true };
  }

  // OFF by default: the feature is gated on its own AppSetting toggle.
  const enabled = (await getSetting(ANOMALY_NOTIFY_ENABLED_KEY)) === 'true';
  if (!enabled) return { sent: false, channel, seeded: false };
  if (channel === 'off') return { sent: false, channel, seeded: false };
  if (!notify || flaggedYm == null) return { sent: false, channel, seeded: false };

  const baseUrl = env.APP_BASE_URL || undefined;
  const n = formatAnomalyNotification(flags, flaggedYm, baseUrl);
  try {
    await dispatch(channel, n, env);
  } catch (err: any) {
    // Leave the watermark unadvanced so we retry next scheduled scrape.
    log(`notify(anomaly): ${channel} send failed for ${flaggedYm}: ${String(err?.message || err).slice(0, 200)}`);
    return { sent: false, channel, seeded: false };
  }
  if (newWatermark != null) await setSetting(LAST_ANOMALY_NOTIFIED_KEY, newWatermark);
  log(`notify(anomaly): sent anomaly alert for ${flaggedYm} via ${channel}`);
  return { sent: true, channel, seeded: false };
}
