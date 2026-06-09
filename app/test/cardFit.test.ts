import { describe, expect, it } from 'vitest';
import { essentialHeightPx, pxToMinRows } from '../src/lib/widgets/cardFit';

// Card-fit arithmetic tests (issue #73 content-fit; compact-stat-cards iteration).
// The arithmetic that decides a stat card's minimum height is PURE, so it's
// hand-calculated here. The compact card body is just the (brief) title + the
// headline value (+ the budget bar) — the old sub/detail line moved into the ⓘ
// tooltip, so there's no longer a detail-line threshold to fence. The registry's
// grid `minH` derives from these same numbers, so fencing them keeps the two in
// lock-step.

describe('essentialHeightPx (hand-calculated, !py-2 padding + .card border)', () => {
  it('simple card = border + padding + title + headline', () => {
    // 2 (border) + 16 (p-2) + 16 (title) + 32 (headline) = 66
    expect(essentialHeightPx('simple')).toBe(66);
  });
  it('budget card shares the SAME essential height (visual-uniformity pass)', () => {
    // The budget progress bar now fits WITHIN the uniform card height (it no longer
    // reserves its own extra row), so budget === simple → one strip-card height.
    expect(essentialHeightPx('budget')).toBe(66);
    expect(essentialHeightPx('budget')).toBe(essentialHeightPx('simple'));
  });
});

describe('pxToMinRows — content px → grid-row minH (hand-calculated)', () => {
  it('ceils so the rows cover the required pixels: n ≥ (px + m)/(rh + m)', () => {
    // simple/budget 66px at the strip rowHeight 30, margin 8: (66+8)/(30+8) =
    // 74/38 = 1.95 → 2 rows. Both kinds now derive the SAME minH (2 rows).
    expect(pxToMinRows(66, 30, 8)).toBe(2);
  });
  it('n rows actually cover the px (n*rh + (n-1)*m ≥ px)', () => {
    for (const px of [66, 78, 100, 150]) {
      const n = pxToMinRows(px, 30, 8);
      expect(n * 30 + (n - 1) * 8).toBeGreaterThanOrEqual(px);
      // And n-1 rows would NOT cover it (n is the minimal sufficient row count).
      if (n > 1) expect((n - 1) * 30 + (n - 2) * 8).toBeLessThan(px);
    }
  });
  it('clamps to at least 1 row', () => {
    expect(pxToMinRows(0, 30, 8)).toBe(1);
    expect(pxToMinRows(10, 30, 8)).toBe(1);
  });
});
