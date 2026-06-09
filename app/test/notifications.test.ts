import { describe, expect, it } from 'vitest';
import {
  buildNotifications,
  deriveNotifications,
  describeAnomaly,
  anomalyKeysToRetract,
  type NotificationsOverview,
} from '../src/lib/notifications';
import type { AnomalyFlag, AnomalyResult } from '../src/lib/anomaly';

// Minimal AnomalyFlag factory — only the fields the notification key + message use
// matter here (ym/fuel/metric/message); the statistical fields are filler.
const mkFlag = (over: Partial<AnomalyFlag>): AnomalyFlag => ({
  fuel: 'elec', metric: 'usage', direction: 'above',
  ym: 202406, latest: 0, median: 0, pct: 0, deviations: 0,
  message: 'electric usage ~30% above weather-normalized expectation',
  ...over,
});

const mkAnomalies = (flags: AnomalyFlag[]): AnomalyResult => ({
  flags,
  ym: flags.length ? Math.max(...flags.map((f) => f.ym)) : null,
});

// An overview with two anomaly flags (electric usage + gas rate) and a latest bill.
const fullOverview: NotificationsOverview = {
  anomalies: mkAnomalies([
    mkFlag({ ym: 202406, fuel: 'elec', metric: 'usage', message: 'electric usage ~30% above weather-normalized expectation' }),
    mkFlag({ ym: 202406, fuel: 'gas', metric: 'rate', direction: 'above', message: 'gas rate ~12% above recent rate band' }),
  ]),
  latestBill: { statementDate: '2026-06-03', totalDueAmount: 192.24 },
};

describe('buildNotifications', () => {
  it('returns [] for a null/undefined overview', () => {
    expect(buildNotifications(null, [])).toEqual([]);
    expect(buildNotifications(undefined, [])).toEqual([]);
  });

  // Two anomaly flags + one bill => 3 items, with the new-bill item pinned first.
  it('produces one item per flag plus one new-bill item, bill first', () => {
    const items = buildNotifications(fullOverview, []);
    expect(items).toHaveLength(3);
    // New-bill item is pinned to the top.
    expect(items[0].kind).toBe('bill');
    expect(items[0].key).toBe('bill:2026-06-03');
    expect(items[0].tone).toBe('info');
    expect(items[0].message).toBe('New bill: $192 (Jun)');
    // The remaining two are the anomaly items, warning-toned, with stable keys.
    expect(items.slice(1).every((n) => n.kind === 'anomaly' && n.tone === 'warning')).toBe(true);
    expect(items.map((n) => n.key)).toEqual([
      'bill:2026-06-03',
      'anomaly:202406:elec:usage',
      'anomaly:202406:gas:rate',
    ]);
    // Anomaly messages come straight from the flag (shared wording with the email).
    expect(items[1].message).toBe('electric usage ~30% above weather-normalized expectation');
  });

  // A dismissed key never reappears; the rest survive.
  it('excludes dismissed keys', () => {
    const items = buildNotifications(fullOverview, ['anomaly:202406:elec:usage']);
    expect(items).toHaveLength(2);
    expect(items.find((n) => n.key === 'anomaly:202406:elec:usage')).toBeUndefined();
    expect(items.map((n) => n.key)).toEqual(['bill:2026-06-03', 'anomaly:202406:gas:rate']);
  });

  // When every key is dismissed the list is empty (drives the empty state + a 0
  // badge that hides).
  it('is empty when all keys are dismissed', () => {
    const items = buildNotifications(fullOverview, [
      'bill:2026-06-03',
      'anomaly:202406:elec:usage',
      'anomaly:202406:gas:rate',
    ]);
    expect(items).toEqual([]);
  });

  // The seeded-data case: no anomalies flagged, but a latest bill exists -> exactly
  // one (new-bill) item, so the bell still shows a badge of 1.
  it('shows just the new-bill item when there are no anomalies', () => {
    const items = buildNotifications(
      { anomalies: mkAnomalies([]), latestBill: { statementDate: '2026-06-03', totalDueAmount: 88.5 } },
      []
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('bill');
    expect(items[0].message).toBe('New bill: $89 (Jun)');
  });

  // No latest bill and no anomalies -> nothing.
  it('is empty with neither a bill nor anomalies', () => {
    expect(buildNotifications({ anomalies: mkAnomalies([]), latestBill: null }, [])).toEqual([]);
    expect(buildNotifications({}, [])).toEqual([]);
  });

  // A null amount still renders a (dash) bill item rather than crashing.
  it('handles a null bill amount', () => {
    const items = buildNotifications({ latestBill: { statementDate: '2026-01-15', totalDueAmount: null } }, []);
    expect(items).toHaveLength(1);
    expect(items[0].message).toBe('New bill: — (Jan)');
  });

  // Each item carries the source data the click-to-open detail view needs: the
  // bill item the latest-bill summary, each anomaly item its full flag.
  it('attaches source data for the detail view', () => {
    const items = buildNotifications(fullOverview, []);
    const bill = items.find((n) => n.kind === 'bill')!;
    expect(bill.bill).toEqual({ statementDate: '2026-06-03', totalDueAmount: 192.24 });
    expect(bill.flag).toBeUndefined();
    const anomaly = items.find((n) => n.key === 'anomaly:202406:elec:usage')!;
    expect(anomaly.flag?.fuel).toBe('elec');
    expect(anomaly.flag?.metric).toBe('usage');
    expect(anomaly.bill).toBeUndefined();
  });
});

describe('deriveNotifications', () => {
  // N bills + M flags => N+M rows, bills first, with the stable keys + payloads.
  it('produces one row per bill plus one per flag with stable keys', () => {
    const bills = [
      { statementDate: '2026-06-03', totalDueAmount: 192.24, periodFrom: '2026-05-01', periodTo: '2026-05-31', hasPdf: true },
      { statementDate: '2026-05-04', totalDueAmount: 88.5, periodFrom: '2026-04-01', periodTo: '2026-04-30', hasPdf: false },
    ];
    const flags = [
      mkFlag({ ym: 202406, fuel: 'elec', metric: 'usage', message: 'electric usage ~30% above weather-normalized expectation' }),
      mkFlag({ ym: 202406, fuel: 'gas', metric: 'rate', direction: 'above', message: 'gas rate ~12% above recent rate band' }),
    ];
    const rows = deriveNotifications(bills, flags, 7);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.key)).toEqual([
      'bill:2026-06-03',
      'bill:2026-05-04',
      'anomaly:202406:elec:usage',
      'anomaly:202406:gas:rate',
    ]);
    // Every row carries the account id and its kind.
    expect(rows.every((r) => r.accountId === 7)).toBe(true);
    expect(rows.slice(0, 2).every((r) => r.kind === 'bill')).toBe(true);
    expect(rows.slice(2).every((r) => r.kind === 'anomaly')).toBe(true);
  });

  // A bill row carries the bill summary as payload (whole-dollar message, period,
  // hasPdf) and a humanized title.
  it('carries the bill summary in the payload', () => {
    const rows = deriveNotifications(
      [{ statementDate: '2026-06-03', totalDueAmount: 192.24, periodFrom: '2026-05-01', periodTo: '2026-05-31', hasPdf: true }],
      [],
      1
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('bill');
    expect(rows[0].title).toBe('New bill');
    expect(rows[0].message).toBe('New bill: $192 (Jun)');
    expect(rows[0].payload).toEqual({
      statementDate: '2026-06-03',
      totalDueAmount: 192.24,
      periodFrom: '2026-05-01',
      periodTo: '2026-05-31',
      hasPdf: true,
    });
  });

  // An anomaly row carries the FULL flag as payload (so describeAnomaly can rebuild
  // the breakdown), the flag message verbatim, and the describeAnomaly title.
  it('carries the full flag in the payload and uses the flag message', () => {
    const flag = mkFlag({
      ym: 202605, fuel: 'elec', metric: 'rate', direction: 'above',
      message: 'electric rate ~12% above recent rate band',
    });
    const rows = deriveNotifications([], [flag], 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('anomaly');
    expect(rows[0].key).toBe('anomaly:202605:elec:rate');
    expect(rows[0].title).toBe('Electric rate anomaly — May 2026');
    expect(rows[0].message).toBe('electric rate ~12% above recent rate band');
    expect(rows[0].payload).toEqual(flag);
  });

  // Defaults: missing period/hasPdf become null/false; a null amount renders a dash.
  it('defaults missing bill fields and handles a null amount', () => {
    const rows = deriveNotifications([{ statementDate: '2026-01-15', totalDueAmount: null }], [], null);
    expect(rows).toHaveLength(1);
    expect(rows[0].accountId).toBeNull();
    expect(rows[0].message).toBe('New bill: — (Jan)');
    expect(rows[0].payload).toEqual({
      statementDate: '2026-01-15',
      totalDueAmount: null,
      periodFrom: null,
      periodTo: null,
      hasPdf: false,
    });
  });

  // No bills and no flags => no rows.
  it('is empty with no bills and no flags', () => {
    expect(deriveNotifications([], [], 1)).toEqual([]);
  });
});

describe('describeAnomaly', () => {
  // Electric RATE anomaly, above, with a finite deviation multiple. Rate values
  // format as $/kWh (3 dp); pct rounds 0.1219 -> +12%; deviations -> "5.2×…".
  it('formats an electric rate anomaly with rate units and a deviation multiple', () => {
    const d = describeAnomaly(mkFlag({
      fuel: 'elec', metric: 'rate', direction: 'above', ym: 202605,
      latest: 0.2412, median: 0.215, pct: 0.1219, deviations: 5.2,
      message: 'electric rate ~12% above recent rate band',
    }));
    expect(d.title).toBe('Electric rate anomaly — May 2026');
    expect(d.headline).toBe('electric rate ~12% above recent rate band');
    expect(d.metricLabel).toBe('all-in price ($/kWh)');
    expect(d.latest).toBe('$0.241');
    expect(d.median).toBe('$0.215');
    expect(d.pct).toBe('+12%');
    expect(d.deviations).toBe('5.2× the normal month-to-month variation');
    expect(d.meaning).toContain('supply rate');
  });

  // Gas USAGE anomaly, below, with a non-finite (flat-history) deviation. Usage
  // values format as a plain 3-dp intensity; pct rounds -0.2267 -> −23% (true minus);
  // Infinity deviations -> the flat-history phrasing.
  it('formats a gas usage anomaly with intensity units and a flat-history fallback', () => {
    const d = describeAnomaly(mkFlag({
      fuel: 'gas', metric: 'usage', direction: 'below', ym: 202601,
      latest: 0.812, median: 1.05, pct: -0.2267, deviations: Number.POSITIVE_INFINITY,
      message: 'gas usage ~23% below weather-normalized expectation',
    }));
    expect(d.title).toBe('Gas usage anomaly — January 2026');
    expect(d.metricLabel).toBe('weather-adjusted usage');
    expect(d.latest).toBe('0.812');
    expect(d.median).toBe('1.050');
    expect(d.pct).toBe('−23%');
    expect(d.deviations).toBe('a jump from a previously flat history');
    expect(d.meaning).toContain('weather');
  });

  // The gas-rate unit is $/therm, and an "above" usage anomaly gets the
  // efficiency-regression / new-load meaning line.
  it('uses $/therm for gas rate and the new-load meaning for usage above', () => {
    expect(describeAnomaly(mkFlag({ fuel: 'gas', metric: 'rate' })).metricLabel).toBe('all-in price ($/therm)');
    const usageAbove = describeAnomaly(mkFlag({ fuel: 'elec', metric: 'usage', direction: 'above' }));
    expect(usageAbove.meaning).toContain('running all the time');
  });
});

describe('anomalyKeysToRetract', () => {
  // Both stored anomaly keys for the latest month are cleared -> both returned.
  it('returns both stored keys when current anomaly keys are empty (transient clears while latest)', () => {
    const stored = ['anomaly:202605:elec:rate', 'anomaly:202605:elec:usage'];
    const result = anomalyKeysToRetract(stored, [], 202605);
    expect(result).toHaveLength(2);
    expect(result).toContain('anomaly:202605:elec:rate');
    expect(result).toContain('anomaly:202605:elec:usage');
  });

  // A stored anomaly key that's still in the current set must NOT be returned.
  it('does not return a genuine anomaly that is still flagged', () => {
    const stored = ['anomaly:202605:elec:rate'];
    const current = ['anomaly:202605:elec:rate'];
    const result = anomalyKeysToRetract(stored, current, 202605);
    expect(result).toEqual([]);
  });

  // A stored anomaly for an older month must not be returned, even though it
  // isn't in the current key set (it's a genuine historical record).
  it('does not touch anomalies for an older ym (non-latest months are never retracted)', () => {
    const stored = ['anomaly:202504:gas:usage'];
    const result = anomalyKeysToRetract(stored, [], 202605);
    expect(result).toEqual([]);
  });

  // Mixed: one stale-latest, one still-current for latest, one older -> only the
  // stale-latest is returned.
  it('returns only the stale-latest key in a mixed set', () => {
    const stored = [
      'anomaly:202605:elec:rate',   // stale latest (should be retracted)
      'anomaly:202605:elec:usage',  // still current (should survive)
      'anomaly:202504:gas:usage',   // older month (must not be touched)
    ];
    const current = ['anomaly:202605:elec:usage'];
    const result = anomalyKeysToRetract(stored, current, 202605);
    expect(result).toEqual(['anomaly:202605:elec:rate']);
  });

  // bill:* keys must never be returned by this helper (they are excluded by the
  // `anomaly:` prefix check; the caller passes only kind='anomaly' keys, but the
  // helper itself must also be safe even if a bill key slips through).
  it('ignores bill keys even if accidentally passed as stored anomaly keys', () => {
    const stored = ['bill:2026-05-04', 'anomaly:202605:elec:rate'];
    const result = anomalyKeysToRetract(stored, [], 202605);
    // Only the anomaly key should be returned; the bill key must not be.
    expect(result).toEqual(['anomaly:202605:elec:rate']);
  });

  // Keys that don't parse cleanly (malformed, missing segments) are skipped.
  it('skips malformed anomaly keys that cannot be parsed', () => {
    const stored = ['anomaly:', 'anomaly:NaN:elec:rate', 'anomaly:202605:elec:rate'];
    const result = anomalyKeysToRetract(stored, [], 202605);
    // Only the well-formed key for latestYm is returned.
    expect(result).toEqual(['anomaly:202605:elec:rate']);
  });
});
