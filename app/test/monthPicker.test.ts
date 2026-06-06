import { describe, expect, it } from 'vitest';
import {
  clampYm,
  isMonthDisabled,
  monthGrid,
  normalizeFromTo,
  ymOf,
  ymParts,
  ymToLabel,
} from '../src/lib/range';

// Pure building blocks behind the visual month/year range picker (issue #39).
// DB-free by construction (the file only does integer/string math). Hand-calculated.

describe('ymOf / ymParts (hand-calculated)', () => {
  it('composes a ym from year + 1-based month', () => {
    expect(ymOf(2024, 5)).toBe(202405);
    expect(ymOf(2024, 12)).toBe(202412);
    expect(ymOf(2026, 1)).toBe(202601);
  });

  it('splits a ym back into year + month', () => {
    expect(ymParts(202405)).toEqual({ year: 2024, month: 5 });
    expect(ymParts(202612)).toEqual({ year: 2026, month: 12 });
  });

  it('round-trips', () => {
    for (const ym of [202201, 202407, 202512, 202601]) {
      const { year, month } = ymParts(ym);
      expect(ymOf(year, month)).toBe(ym);
    }
  });
});

describe('monthGrid (hand-calculated)', () => {
  it('returns twelve cells Jan…Dec for a year', () => {
    const g = monthGrid(2024);
    expect(g).toHaveLength(12);
    expect(g[0]).toEqual({ month: 1, label: 'Jan', ym: 202401 });
    expect(g[4]).toEqual({ month: 5, label: 'May', ym: 202405 });
    expect(g[11]).toEqual({ month: 12, label: 'Dec', ym: 202412 });
  });

  it('uses the requested year for every cell', () => {
    expect(monthGrid(2026).map((c) => c.ym)).toEqual([
      202601, 202602, 202603, 202604, 202605, 202606, 202607, 202608, 202609, 202610, 202611, 202612,
    ]);
  });
});

describe('clampYm (hand-calculated)', () => {
  it('clamps below the min and above the max', () => {
    expect(clampYm(202401, 202403, 202412)).toBe(202403);
    expect(clampYm(202412, 202403, 202410)).toBe(202410);
  });

  it('passes through a ym already inside the window', () => {
    expect(clampYm(202406, 202401, 202412)).toBe(202406);
  });

  it('treats null bounds as open on that side', () => {
    expect(clampYm(202401, null, 202412)).toBe(202401);
    expect(clampYm(202499, 202401, null)).toBe(202499);
    expect(clampYm(202406, null, null)).toBe(202406);
  });
});

describe('ymToLabel (hand-calculated)', () => {
  it('formats ym as "Mon YYYY"', () => {
    expect(ymToLabel(202405)).toBe('May 2024');
    expect(ymToLabel(202601)).toBe('Jan 2026');
    expect(ymToLabel(202412)).toBe('Dec 2024');
  });

  it('renders a dash for a null/undefined ym', () => {
    expect(ymToLabel(null)).toBe('—');
    expect(ymToLabel(undefined)).toBe('—');
  });
});

describe('isMonthDisabled (hand-calculated)', () => {
  it('disables months outside [min, max]', () => {
    expect(isMonthDisabled(202312, 202401, 202412)).toBe(true); // before min
    expect(isMonthDisabled(202501, 202401, 202412)).toBe(true); // after max
  });

  it('enables months inside the window (inclusive bounds)', () => {
    expect(isMonthDisabled(202401, 202401, 202412)).toBe(false);
    expect(isMonthDisabled(202412, 202401, 202412)).toBe(false);
    expect(isMonthDisabled(202406, 202401, 202412)).toBe(false);
  });

  it('open bounds never disable that side', () => {
    expect(isMonthDisabled(202301, null, 202412)).toBe(false);
    expect(isMonthDisabled(202999, 202401, null)).toBe(false);
    expect(isMonthDisabled(202406, null, null)).toBe(false);
  });
});

describe('normalizeFromTo (hand-calculated)', () => {
  it('keeps an already-ordered pair', () => {
    expect(normalizeFromTo(202401, 202412)).toEqual({ fromYm: 202401, toYm: 202412 });
  });

  it('swaps an inverted pair', () => {
    expect(normalizeFromTo(202412, 202401)).toEqual({ fromYm: 202401, toYm: 202412 });
  });

  it('handles an equal pair (single month)', () => {
    expect(normalizeFromTo(202406, 202406)).toEqual({ fromYm: 202406, toYm: 202406 });
  });
});
