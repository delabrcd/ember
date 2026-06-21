import { describe, expect, it } from 'vitest';
import { chooseBucket, BUCKET_LADDER_SECONDS } from '../src/lib/viz/chooseBucket';

// Hand-calculated tests for the PURE bucket-width selector (WS1 rework of #36).
// chooseBucket(spanMs, maxPoints) returns the SMALLEST ladder width (seconds) such
// that ceil(spanSecs / width) ≤ maxPoints — the finest resolution that fits the
// point budget. DISPLAY-only — it never feeds a billed number.

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

describe('chooseBucket', () => {
  it('exposes the ladder smallest→largest, all clean 15-min multiples', () => {
    expect(BUCKET_LADDER_SECONDS).toEqual([900, 3600, 7200, 10800, 21600, 43200, 86400, 604800]);
    for (const s of BUCKET_LADDER_SECONDS) expect(s % 900).toBe(0); // tiles the 15-min grid
    for (let i = 1; i < BUCKET_LADDER_SECONDS.length; i++) {
      expect(BUCKET_LADDER_SECONDS[i]).toBeGreaterThan(BUCKET_LADDER_SECONDS[i - 1]);
    }
  });

  it('picks 900s (15-min) for a window that fits at the finest grain', () => {
    // 1 day at 900s = 86400/900 = 96 buckets ≤ 600 → 900 fits.
    expect(chooseBucket(DAY, 600)).toBe(900);
    // 6 days at 900s = ceil(6*86400/900) = 576 ≤ 600 → still 900 (the brief's
    // "≤ ~6 days → ≤ ~576 slots" 15-min-grid boundary).
    expect(chooseBucket(6 * DAY, 600)).toBe(900);
  });

  it('steps up to 1h (3600s) when 15-min would exceed the budget', () => {
    // 7 days at 900s = ceil(7*86400/900) = 672 > 600 → 900 fails.
    // 7 days at 3600s = ceil(7*86400/3600) = 168 ≤ 600 → 3600 fits.
    expect(chooseBucket(7 * DAY, 600)).toBe(3600);
    // 30 days at 3600s = ceil(30*24) = 720 > 600 → 3600 fails.
    // 30 days at 7200s (2h) = ceil(720/2) = 360 ≤ 600 → 7200 fits.
    expect(chooseBucket(30 * DAY, 600)).toBe(7200);
  });

  it('climbs the ladder for progressively wider windows', () => {
    // 90 days: at 1d=86400 → 90 buckets ≤ 600. But finer first: 6h=21600 →
    // ceil(90*86400/21600) = ceil(360) = 360 ≤ 600 → 6h wins (smaller than 12h/1d).
    // Re-check 3h=10800 → ceil(90*86400/10800)=720 > 600 → fails; so 6h is finest fit.
    expect(chooseBucket(90 * DAY, 600)).toBe(21600);
    // ~1 year: 365d at 1d=86400 → 365 ≤ 600 → 1d. Finer 12h=43200 →
    // ceil(365*2)=730 > 600 → fails. So 1 day (86400) is the finest fit.
    expect(chooseBucket(365 * DAY, 600)).toBe(86400);
    // ~3 years: 1095d at 1d → 1095 > 600 → fails; at 1w=604800 →
    // ceil(1095/7) = 157 ≤ 600 → 1 week.
    expect(chooseBucket(1095 * DAY, 600)).toBe(604800);
  });

  it('falls back to the coarsest width when even 1-week buckets overflow', () => {
    // 100 years at 1 week ≈ ceil(36500/7) = 5215 > 600 — no ladder width fits, so
    // we return the coarsest (1 week) as the most-decimated honest option.
    expect(chooseBucket(100 * 365 * DAY, 600)).toBe(604800);
  });

  it('returns the finest width for a zero/degenerate span (≤ 1 bucket to emit)', () => {
    expect(chooseBucket(0, 600)).toBe(900);
    expect(chooseBucket(-5, 600)).toBe(900);
    expect(chooseBucket(NaN, 600)).toBe(900);
  });

  it('returns the coarsest width when the point budget is non-positive', () => {
    expect(chooseBucket(DAY, 0)).toBe(604800);
    expect(chooseBucket(DAY, -10)).toBe(604800);
    expect(chooseBucket(DAY, NaN)).toBe(604800);
  });

  it('honors a tiny budget by jumping up the ladder', () => {
    // 1 week (604800s) with maxPoints=1: 1 week at 1-week buckets = exactly 1 ≤ 1.
    // Finer widths all exceed 1, so 1 week is the only fit.
    expect(chooseBucket(WEEK, 1)).toBe(604800);
    // 2 hours with maxPoints=2: 900s → ceil(7200/900)=8 > 2; 3600s → 2 ≤ 2 → 1h.
    expect(chooseBucket(2 * HOUR, 2)).toBe(3600);
  });
});
