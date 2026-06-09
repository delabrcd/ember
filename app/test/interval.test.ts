import { describe, expect, it } from 'vitest';
import {
  parseIntervalReads,
  parseAmiEnergyUsages,
  extractAmiMeters,
  amiIntervalUrl,
  amiEnergyUsagesBody,
  intervalDateWindow,
  backfillStartFor,
  normalizeFuel,
  unitForFuel,
  AMI_ENERGY_USAGES_QUERY,
} from '../src/lib/ngrid/interval';

const BASE = 'https://myaccount.nationalgrid.com';

describe('parseIntervalReads (hand-calculated)', () => {
  it('parses a 15-minute electric read: 900s and correct UTC instant', () => {
    const rows = parseIntervalReads(
      [{ startTime: '2026-06-08T23:30:00-04:00', endTime: '2026-06-08T23:45:00-04:00', value: 0.247259 }],
      'Electric',
      'kWh'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].intervalSeconds).toBe(900);
    expect(rows[0].quantity).toBeCloseTo(0.247259, 6);
    expect(rows[0].fuelType).toBe('ELECTRIC');
    expect(rows[0].unit).toBe('kWh');
    expect(rows[0].source).toBe('portal');
    // 23:30 at -04:00 == 03:30 next day UTC.
    expect(rows[0].intervalStart.toISOString()).toBe('2026-06-09T03:30:00.000Z');
  });

  it('parses an hourly read as 3600s', () => {
    const rows = parseIntervalReads(
      [{ startTime: '2026-06-08T01:00:00-04:00', endTime: '2026-06-08T02:00:00-04:00', value: 1.5 }],
      'Gas',
      'therms'
    );
    expect(rows[0].intervalSeconds).toBe(3600);
    expect(rows[0].fuelType).toBe('GAS');
    expect(rows[0].unit).toBe('therms');
  });

  it('keeps both DST fall-back 01:00 locals as distinct UTC instants', () => {
    // Nov 1 2026 02:00 EDT → 01:00 EST. The 01:00–01:15 local interval occurs
    // twice: first at -04:00 (EDT), then at -05:00 (EST). Different UTC instants.
    const rows = parseIntervalReads(
      [
        { startTime: '2026-11-01T01:00:00-04:00', endTime: '2026-11-01T01:15:00-04:00', value: 0.1 },
        { startTime: '2026-11-01T01:00:00-05:00', endTime: '2026-11-01T01:15:00-05:00', value: 0.2 },
      ],
      'Electric',
      'kWh'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].intervalStart.toISOString()).toBe('2026-11-01T05:00:00.000Z');
    expect(rows[1].intervalStart.toISOString()).toBe('2026-11-01T06:00:00.000Z');
    // Distinct storage keys → no unique collision.
    const keys = new Set(rows.map((r) => `${r.intervalStart.getTime()}:${r.intervalSeconds}`));
    expect(keys.size).toBe(2);
  });

  it('dedups a repeated read, keeping the last value', () => {
    const rows = parseIntervalReads(
      [
        { startTime: '2026-06-08T00:00:00-04:00', endTime: '2026-06-08T00:15:00-04:00', value: 0.1 },
        { startTime: '2026-06-08T00:00:00-04:00', endTime: '2026-06-08T00:15:00-04:00', value: 0.9 },
      ],
      'Electric',
      'kWh'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(0.9);
  });

  it('drops non-finite values, zero-length and unparseable intervals', () => {
    const rows = parseIntervalReads(
      [
        { startTime: '2026-06-08T00:00:00-04:00', endTime: '2026-06-08T00:15:00-04:00', value: NaN },
        { startTime: '2026-06-08T00:00:00-04:00', endTime: '2026-06-08T00:00:00-04:00', value: 1 }, // zero length
        { startTime: 'not-a-date', endTime: '2026-06-08T00:15:00-04:00', value: 1 },
        { startTime: '2026-06-08T01:00:00-04:00', endTime: '2026-06-08T01:15:00-04:00', value: 0.5 }, // good
      ],
      'Electric',
      'kWh'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBe(0.5);
  });

  it('sorts out-of-order reads by intervalStart', () => {
    const rows = parseIntervalReads(
      [
        { startTime: '2026-06-08T02:00:00-04:00', endTime: '2026-06-08T02:15:00-04:00', value: 2 },
        { startTime: '2026-06-08T01:00:00-04:00', endTime: '2026-06-08T01:15:00-04:00', value: 1 },
      ],
      'Electric',
      'kWh'
    );
    expect(rows.map((r) => r.quantity)).toEqual([1, 2]);
  });
});

describe('extractAmiMeters', () => {
  it('keeps only hasAmiSmartMeter nodes and normalizes fuel + servicePointNumber + meterPointNumber', () => {
    const ba = {
      meter: {
        nodes: [
          {
            fuelType: 'Electric',
            servicePointNumber: 12345,
            meterNumber: 'M1',
            meterPointNumber: 2,
            hasAmiSmartMeter: true,
          },
          { fuelType: 'Gas', servicePointNumber: '67890', hasAmiSmartMeter: false },
          { fuelType: 'Gas', servicePointNumber: '99999', isSmartMeter: true }, // no hasAmiSmartMeter
        ],
      },
    };
    const meters = extractAmiMeters(ba);
    expect(meters).toHaveLength(1);
    expect(meters[0]).toEqual({
      fuelType: 'ELECTRIC',
      servicePointNumber: '12345',
      meterNumber: 'M1',
      meterPointNumber: '2',
    });
  });

  it('defaults meterPointNumber to "1" when the node omits it', () => {
    const ba = {
      meter: {
        nodes: [
          { fuelType: 'Gas', servicePointNumber: '100', meterNumber: '03858858', hasAmiSmartMeter: true },
        ],
      },
    };
    const meters = extractAmiMeters(ba);
    expect(meters[0].meterPointNumber).toBe('1');
  });

  it('drops AMI nodes missing a servicePointNumber', () => {
    const ba = { meter: { nodes: [{ fuelType: 'Gas', hasAmiSmartMeter: true }] } };
    expect(extractAmiMeters(ba)).toEqual([]);
  });

  it('tolerates garbage / missing shapes', () => {
    expect(extractAmiMeters(undefined)).toEqual([]);
    expect(extractAmiMeters(null)).toEqual([]);
    expect(extractAmiMeters({})).toEqual([]);
    expect(extractAmiMeters({ meter: {} })).toEqual([]);
    expect(extractAmiMeters({ meter: { nodes: 'nope' } })).toEqual([]);
    expect(extractAmiMeters({ meter: { nodes: [null, 42, 'x'] } })).toEqual([]);
  });
});

describe('amiIntervalUrl', () => {
  it('builds the endpoint and encodes the startDateTime space', () => {
    expect(amiIntervalUrl(BASE, '111', '222', '2026-05-01 00:00:00')).toBe(
      'https://myaccount.nationalgrid.com/api/amiadapter-cu-uwp-sys/v1/interval/reads/111/222?startDateTime=2026-05-01%2000:00:00'
    );
  });

  it('strips a trailing slash on base', () => {
    expect(amiIntervalUrl(BASE + '/', '1', '2', '2026-01-01 00:00:00')).toContain(
      '.com/api/amiadapter-cu-uwp-sys'
    );
  });
});

describe('backfillStartFor', () => {
  const now = new Date('2026-06-09T12:00:00Z');

  it('uses the explicit backfillFromIso override', () => {
    expect(backfillStartFor(now, null, '2025-01-01', 35)).toBe('2025-01-01 00:00:00');
  });

  it('uses lastStored minus a 1-day overlap', () => {
    expect(backfillStartFor(now, new Date('2026-06-08T03:30:00Z'), undefined, 35)).toBe(
      '2026-06-07 03:30:00'
    );
  });

  it('falls back to now minus windowDays', () => {
    expect(backfillStartFor(now, null, undefined, 35)).toBe('2026-05-05 12:00:00');
  });

  it('ignores an unparseable override and falls through', () => {
    expect(backfillStartFor(now, null, 'garbage', 35)).toBe('2026-05-05 12:00:00');
  });
});

describe('parseAmiEnergyUsages (gas gql, hand-calculated)', () => {
  it('infers hourly nodes as 3600s with correct UTC instants', () => {
    const rows = parseAmiEnergyUsages(
      [
        { date: '2026-06-01T00:00:00.000-04:00', fuelType: 'GAS', quantity: 0.02076 },
        { date: '2026-06-01T01:00:00.000-04:00', fuelType: 'GAS', quantity: 0.0191 },
        { date: '2026-06-01T02:00:00.000-04:00', fuelType: 'GAS', quantity: 0.018 },
      ],
      'GAS'
    );
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.intervalSeconds).toBe(3600);
      expect(r.fuelType).toBe('GAS');
      expect(r.unit).toBe('therms');
      expect(r.source).toBe('portal');
    }
    // 00:00 at -04:00 == 04:00 UTC.
    expect(rows[0].intervalStart.toISOString()).toBe('2026-06-01T04:00:00.000Z');
    expect(rows[0].quantity).toBeCloseTo(0.02076, 6);
    expect(rows[2].intervalStart.toISOString()).toBe('2026-06-01T06:00:00.000Z');
  });

  it('infers daily-spaced nodes as 86400s', () => {
    const rows = parseAmiEnergyUsages(
      [
        { date: '2026-06-01T00:00:00.000-04:00', fuelType: 'GAS', quantity: 1.2 },
        { date: '2026-06-02T00:00:00.000-04:00', fuelType: 'GAS', quantity: 1.3 },
        { date: '2026-06-03T00:00:00.000-04:00', fuelType: 'GAS', quantity: 1.1 },
      ],
      'GAS'
    );
    expect(rows.map((r) => r.intervalSeconds)).toEqual([86400, 86400, 86400]);
  });

  it('defaults a single node to 3600s', () => {
    const rows = parseAmiEnergyUsages(
      [{ date: '2026-06-01T00:00:00.000-04:00', fuelType: 'GAS', quantity: 0.5 }],
      'GAS'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].intervalSeconds).toBe(3600);
  });

  it('last node reuses the previous gap', () => {
    const rows = parseAmiEnergyUsages(
      [
        { date: '2026-06-01T00:00:00.000-04:00', fuelType: 'GAS', quantity: 1 },
        { date: '2026-06-01T01:00:00.000-04:00', fuelType: 'GAS', quantity: 2 },
      ],
      'GAS'
    );
    expect(rows.map((r) => r.intervalSeconds)).toEqual([3600, 3600]);
  });

  it('uses the passed fuelType when the node omits it, and unit follows fuel', () => {
    const rows = parseAmiEnergyUsages(
      [{ date: '2026-06-01T00:00:00.000-04:00', quantity: 0.5 }],
      'Gas'
    );
    expect(rows[0].fuelType).toBe('GAS');
    expect(rows[0].unit).toBe('therms');
  });

  it('drops non-finite quantities and unparseable dates', () => {
    const rows = parseAmiEnergyUsages(
      [
        { date: '2026-06-01T00:00:00.000-04:00', fuelType: 'GAS', quantity: NaN },
        { date: 'not-a-date', fuelType: 'GAS', quantity: 1 },
        { date: '2026-06-01T02:00:00.000-04:00', fuelType: 'GAS', quantity: 0.7 },
      ],
      'GAS'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBeCloseTo(0.7, 6);
  });

  it('sorts out-of-order nodes and dedups keeping the last value', () => {
    const rows = parseAmiEnergyUsages(
      [
        { date: '2026-06-01T02:00:00.000-04:00', fuelType: 'GAS', quantity: 2 },
        { date: '2026-06-01T01:00:00.000-04:00', fuelType: 'GAS', quantity: 1 },
        { date: '2026-06-01T01:00:00.000-04:00', fuelType: 'GAS', quantity: 9 }, // dup of 01:00
      ],
      'GAS'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].intervalStart.toISOString()).toBe('2026-06-01T05:00:00.000Z');
    expect(rows[0].quantity).toBe(9); // last 01:00 wins
    expect(rows[1].intervalStart.toISOString()).toBe('2026-06-01T06:00:00.000Z');
  });

  it('falls back to 3600 for an absurd (data-hole) gap', () => {
    const rows = parseAmiEnergyUsages(
      [
        { date: '2026-01-01T00:00:00.000-05:00', fuelType: 'GAS', quantity: 1 },
        { date: '2026-06-01T00:00:00.000-04:00', fuelType: 'GAS', quantity: 2 }, // ~5 months later
      ],
      'GAS'
    );
    expect(rows[0].intervalSeconds).toBe(3600);
  });

  it('tolerates a non-array input', () => {
    expect(parseAmiEnergyUsages(undefined as never, 'GAS')).toEqual([]);
  });
});

describe('amiEnergyUsagesBody', () => {
  it('builds the NrtDailyUsage POST body with the right variables', () => {
    const body = amiEnergyUsagesBody(
      { meterNumber: '03858858', servicePointNumber: '100', meterPointNumber: '1' },
      '520998000',
      '2026-06-01',
      '2026-06-07'
    );
    expect(body.operationName).toBe('NrtDailyUsage');
    expect(body.query).toBe(AMI_ENERGY_USAGES_QUERY);
    expect(body.variables).toEqual({
      meterNumber: '03858858',
      premiseNumber: '520998000',
      servicePointNumber: '100',
      meterPointNumber: '1',
      dateFrom: '2026-06-01',
      dateTo: '2026-06-07',
    });
  });

  it('stringifies a missing meterNumber to empty string', () => {
    const body = amiEnergyUsagesBody(
      { servicePointNumber: '100', meterPointNumber: '1' },
      '520998000',
      '2026-06-01',
      '2026-06-07'
    );
    expect(body.variables.meterNumber).toBe('');
  });
});

describe('intervalDateWindow', () => {
  const now = new Date('2026-06-09T12:00:00Z');

  it('dateTo = now, dateFrom = now − windowDays by default', () => {
    expect(intervalDateWindow(now, undefined, 35)).toEqual({
      dateFrom: '2026-05-05',
      dateTo: '2026-06-09',
    });
  });

  it('uses an explicit backfillFromIso override for dateFrom', () => {
    expect(intervalDateWindow(now, '2025-01-01', 35)).toEqual({
      dateFrom: '2025-01-01',
      dateTo: '2026-06-09',
    });
  });

  it('ignores an unparseable override and falls back to the window', () => {
    expect(intervalDateWindow(now, 'garbage', 7)).toEqual({
      dateFrom: '2026-06-02',
      dateTo: '2026-06-09',
    });
  });
});

describe('fuel helpers', () => {
  it('normalizeFuel maps portal labels', () => {
    expect(normalizeFuel('Electric')).toBe('ELECTRIC');
    expect(normalizeFuel('ELECTRIC')).toBe('ELECTRIC');
    expect(normalizeFuel('Electricity')).toBe('ELECTRIC');
    expect(normalizeFuel('Gas')).toBe('GAS');
    expect(normalizeFuel('Steam')).toBe('STEAM');
  });

  it('unitForFuel maps fuel → unit', () => {
    expect(unitForFuel('Electric')).toBe('kWh');
    expect(unitForFuel('Gas')).toBe('therms');
    expect(unitForFuel('Steam')).toBe('');
  });
});
