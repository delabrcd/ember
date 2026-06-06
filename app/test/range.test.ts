import { describe, expect, it } from 'vitest';
import {
  resolveRange,
  ymMinusMonths,
  ymdToYm,
  ymToYmd,
  filterByYm,
  filterBillsByYm,
  migrateRangeMonths,
  type RangePref,
} from '../src/lib/range';

// A realistic, contiguous span of data: Jan 2022 → Dec 2024 (36 months).
const YMS = (() => {
  const out: number[] = [];
  for (let y = 2022; y <= 2024; y++) for (let m = 1; m <= 12; m++) out.push(y * 100 + m);
  return out;
})();
const NOW = 202412; // pretend "today" is Dec 2024

describe('ym arithmetic (hand-calculated)', () => {
  it('subtracts months across a year boundary', () => {
    expect(ymMinusMonths(202412, 11)).toBe(202401); // 12-mo window ending Dec → starts Jan
    expect(ymMinusMonths(202401, 1)).toBe(202312);
    expect(ymMinusMonths(202403, 5)).toBe(202310);
    expect(ymMinusMonths(202412, 23)).toBe(202301); // 24-mo window
  });

  it('parses YYYY-MM-DD / YYYY-MM to ym, rejecting junk', () => {
    expect(ymdToYm('2024-05-17')).toBe(202405);
    expect(ymdToYm('2024-05')).toBe(202405);
    expect(ymdToYm('')).toBeNull();
    expect(ymdToYm(null)).toBeNull();
    expect(ymdToYm('not-a-date')).toBeNull();
  });

  it('formats a ym back to the first of the month', () => {
    expect(ymToYmd(202405)).toBe('2024-05-01');
    expect(ymToYmd(202412)).toBe('2024-12-01');
    expect(ymToYmd(null)).toBe('');
  });
});

describe('resolveRange — presets (hand-calculated)', () => {
  it('all → the full data span', () => {
    expect(resolveRange({ preset: 'all', fromYm: null, toYm: null }, YMS, NOW)).toEqual({
      fromYm: 202201,
      toYm: 202412,
    });
  });

  it('ytd → Jan of the current year through the latest data', () => {
    expect(resolveRange({ preset: 'ytd', fromYm: null, toYm: null }, YMS, NOW)).toEqual({
      fromYm: 202401,
      toYm: 202412,
    });
  });

  it('12mo → trailing 12 months ending at the anchor', () => {
    expect(resolveRange({ preset: '12mo', fromYm: null, toYm: null }, YMS, NOW)).toEqual({
      fromYm: 202401,
      toYm: 202412,
    });
  });

  it('24mo → trailing 24 months', () => {
    expect(resolveRange({ preset: '24mo', fromYm: null, toYm: null }, YMS, NOW)).toEqual({
      fromYm: 202301,
      toYm: 202412,
    });
  });

  it('36mo covering the whole span equals all here', () => {
    expect(resolveRange({ preset: '36mo', fromYm: null, toYm: null }, YMS, NOW)).toEqual({
      fromYm: 202201,
      toYm: 202412,
    });
  });
});

describe('resolveRange — clamping & anchoring (hand-calculated)', () => {
  it('clamps a window that reaches before the first data point to the data edge', () => {
    // Only 6 months of data, but a 36-mo window requested.
    const six = [202407, 202408, 202409, 202410, 202411, 202412];
    expect(resolveRange({ preset: '36mo', fromYm: null, toYm: null }, six, NOW)).toEqual({
      fromYm: 202407,
      toYm: 202412,
    });
  });

  it('anchors trailing windows to the latest data when it is past "now"', () => {
    // Clock says Jan 2024 but data runs to Dec 2024 → anchor to Dec 2024.
    expect(resolveRange({ preset: '12mo', fromYm: null, toYm: null }, YMS, 202401)).toEqual({
      fromYm: 202401,
      toYm: 202412,
    });
  });

  it('empty data → a degenerate range at nowYm', () => {
    expect(resolveRange({ preset: 'all', fromYm: null, toYm: null }, [], NOW)).toEqual({
      fromYm: 202412,
      toYm: 202412,
    });
    expect(resolveRange({ preset: '12mo', fromYm: null, toYm: null }, [], NOW)).toEqual({
      fromYm: 202412,
      toYm: 202412,
    });
  });
});

describe('resolveRange — custom (hand-calculated)', () => {
  it('uses explicit custom bounds', () => {
    expect(resolveRange({ preset: 'custom', fromYm: 202303, toYm: 202308 }, YMS, NOW)).toEqual({
      fromYm: 202303,
      toYm: 202308,
    });
  });

  it('falls back to the data edge for a null side', () => {
    expect(resolveRange({ preset: 'custom', fromYm: null, toYm: 202306 }, YMS, NOW)).toEqual({
      fromYm: 202201,
      toYm: 202306,
    });
    expect(resolveRange({ preset: 'custom', fromYm: 202311, toYm: null }, YMS, NOW)).toEqual({
      fromYm: 202311,
      toYm: 202412,
    });
  });

  it('normalises an inverted custom range by swapping', () => {
    expect(resolveRange({ preset: 'custom', fromYm: 202308, toYm: 202303 }, YMS, NOW)).toEqual({
      fromYm: 202303,
      toYm: 202308,
    });
  });
});

describe('filters honour resolved bounds (hand-calculated)', () => {
  const rows = YMS.map((ym) => ({ ym, label: String(ym) }));
  const bills = YMS.map((ym) => ({ statementDate: ymToYmd(ym).replace('-01', '-15') }));

  it('filterByYm keeps only rows in [from, to] inclusive', () => {
    const r = { fromYm: 202305, toYm: 202308 };
    const kept = filterByYm(rows, r).map((x) => x.ym);
    expect(kept).toEqual([202305, 202306, 202307, 202308]);
  });

  it('filterBillsByYm keeps bills whose statement month is in range', () => {
    const r = { fromYm: 202411, toYm: 202412 };
    const kept = filterBillsByYm(bills, r).map((b) => b.statementDate);
    expect(kept).toEqual(['2024-11-15', '2024-12-15']);
  });
});

describe('migrateRangeMonths (hand-calculated)', () => {
  const cases: [number | null | undefined, RangePref][] = [
    [0, { preset: 'all', fromYm: null, toYm: null }],
    [12, { preset: '12mo', fromYm: null, toYm: null }],
    [24, { preset: '24mo', fromYm: null, toYm: null }],
    [36, { preset: '36mo', fromYm: null, toYm: null }],
    [99, { preset: 'all', fromYm: null, toYm: null }],
    [undefined, { preset: 'all', fromYm: null, toYm: null }],
    [null, { preset: 'all', fromYm: null, toYm: null }],
  ];
  it.each(cases)('maps rangeMonths=%s to the right preset', (input, expected) => {
    expect(migrateRangeMonths(input)).toEqual(expected);
  });
});
