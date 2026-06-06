import { describe, expect, it } from 'vitest';
import {
  formatBillNotification,
  resolveChannel,
  selectBillsToNotify,
  type NotifiableBill,
} from '../src/lib/notifyFormat';

const D = (s: string) => new Date(s + 'T00:00:00Z');

function bill(p: {
  statement: string;
  from?: string;
  to?: string;
  charges?: number | null;
}): NotifiableBill {
  return {
    statementDate: D(p.statement),
    periodFrom: p.from ? D(p.from) : null,
    periodTo: p.to ? D(p.to) : null,
    currentCharges: p.charges === undefined ? null : p.charges,
  };
}

describe('formatBillNotification (pure)', () => {
  it('uses currentCharges as the amount and includes period + statement date', () => {
    const n = formatBillNotification(
      bill({ statement: '2026-05-11', from: '2026-04-10', to: '2026-05-09', charges: 123.45 })
    );
    expect(n.amount).toBe(123.45);
    expect(n.statementDate).toBe('2026-05-11');
    expect(n.subject).toBe('New National Grid bill: $123.45 (statement 2026-05-11)');
    expect(n.body).toContain('Charges: $123.45');
    expect(n.body).toContain('Service period: 2026-04-10 → 2026-05-09');
    expect(n.body).toContain('Statement date: 2026-05-11');
    expect(n.link).toBeUndefined();
    expect(n.body).not.toContain('Dashboard:');
  });

  it('appends a trailing-slash-normalized dashboard link when baseUrl is given', () => {
    const n = formatBillNotification(bill({ statement: '2026-05-11', charges: 10 }), 'https://ng.example.com/');
    expect(n.link).toBe('https://ng.example.com/');
    expect(n.body).toContain('Dashboard: https://ng.example.com/');
  });

  it('handles a missing amount and missing period gracefully', () => {
    const n = formatBillNotification(bill({ statement: '2026-05-11', charges: null }));
    expect(n.amount).toBeNull();
    expect(n.subject).toContain('n/a (statement 2026-05-11)');
    expect(n.body).toContain('Charges: n/a');
    expect(n.body).toContain('Service period: n/a');
  });
});

describe('selectBillsToNotify (pure watermark dedupe)', () => {
  const bills = [
    bill({ statement: '2026-03-11' }),
    bill({ statement: '2026-04-13' }),
    bill({ statement: '2026-05-11' }),
  ];

  it('first run (null watermark) seeds to the max date and notifies nothing', () => {
    const r = selectBillsToNotify(bills, null);
    expect(r.toNotify).toEqual([]);
    expect(r.newWatermark).toBe('2026-05-11');
  });

  it('notifies only bills strictly newer than the watermark, oldest-first', () => {
    const r = selectBillsToNotify(bills, '2026-03-11');
    expect(r.toNotify.map((b) => b.statementDate.toISOString().slice(0, 10))).toEqual([
      '2026-04-13',
      '2026-05-11',
    ]);
    expect(r.newWatermark).toBe('2026-05-11');
  });

  it('is a no-op when the watermark already equals the latest bill', () => {
    const r = selectBillsToNotify(bills, '2026-05-11');
    expect(r.toNotify).toEqual([]);
    expect(r.newWatermark).toBe('2026-05-11');
  });

  it('handles multiple new bills landing in one scrape', () => {
    const r = selectBillsToNotify(bills, '2026-02-01');
    expect(r.toNotify).toHaveLength(3);
    expect(r.newWatermark).toBe('2026-05-11');
  });

  it('leaves the watermark untouched when there are no bills', () => {
    expect(selectBillsToNotify([], '2026-05-11')).toEqual({ toNotify: [], newWatermark: '2026-05-11' });
    expect(selectBillsToNotify([], null)).toEqual({ toNotify: [], newWatermark: null });
  });

  it('does not depend on input ordering', () => {
    const shuffled = [bills[2], bills[0], bills[1]];
    const r = selectBillsToNotify(shuffled, '2026-03-11');
    expect(r.toNotify.map((b) => b.statementDate.toISOString().slice(0, 10))).toEqual([
      '2026-04-13',
      '2026-05-11',
    ]);
    expect(r.newWatermark).toBe('2026-05-11');
  });
});

describe('resolveChannel (env → channel)', () => {
  it('defaults to off with empty env', () => {
    expect(resolveChannel({})).toBe('off');
  });

  it('honors an explicit NOTIFY_CHANNEL', () => {
    expect(resolveChannel({ NOTIFY_CHANNEL: 'ntfy' })).toBe('ntfy');
    expect(resolveChannel({ NOTIFY_CHANNEL: 'WEBHOOK' })).toBe('webhook');
    expect(resolveChannel({ NOTIFY_CHANNEL: 'off', NOTIFY_WEBHOOK_URL: 'x' })).toBe('off');
  });

  it('falls back to off for an unrecognized explicit value (never throws)', () => {
    expect(resolveChannel({ NOTIFY_CHANNEL: 'pigeon' })).toBe('off');
  });

  it('infers a channel from the relevant env when NOTIFY_CHANNEL is unset', () => {
    expect(resolveChannel({ NOTIFY_WEBHOOK_URL: 'https://x' })).toBe('webhook');
    expect(resolveChannel({ NTFY_TOPIC: 'mytopic' })).toBe('ntfy');
    expect(resolveChannel({ SMTP_HOST: 'smtp.example.com' })).toBe('smtp');
  });
});
