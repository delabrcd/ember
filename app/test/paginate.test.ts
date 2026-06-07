import { describe, expect, it } from 'vitest';
import { clampPage, paginate } from '../src/lib/cockpit';
import { estimateTooltip } from '../src/lib/format';

// paginate splits the visible charts into fixed-size pages for the cockpit's
// 2×2 "fit" grid (issue #38): 6 visible → [4, 2]. PURE.
describe('paginate (hand-calculated)', () => {
  it('splits six items into a full page of four and a remainder of two', () => {
    expect(paginate(['a', 'b', 'c', 'd', 'e', 'f'], 4)).toEqual([
      ['a', 'b', 'c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('keeps four-or-fewer items on a single page (no arrows case)', () => {
    expect(paginate(['a', 'b', 'c', 'd'], 4)).toEqual([['a', 'b', 'c', 'd']]);
    expect(paginate(['a'], 4)).toEqual([['a']]);
  });

  it('yields no pages for an empty list', () => {
    expect(paginate([], 4)).toEqual([]);
  });

  it('preserves order across pages', () => {
    expect(paginate([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('clamps a bad perPage to at least one per page (no zero-size loop)', () => {
    expect(paginate(['a', 'b'], 0)).toEqual([['a'], ['b']]);
    expect(paginate(['a', 'b'], -3)).toEqual([['a'], ['b']]);
    // Fractional perPage floors to a whole page size.
    expect(paginate(['a', 'b', 'c'], 2.9)).toEqual([['a', 'b'], ['c']]);
  });
});

// clampPage wraps/clamps the active page index so the prev/next arrows can never
// select an out-of-range page, even after the visible set shrinks. PURE.
describe('clampPage (hand-calculated)', () => {
  it('passes through an in-range index', () => {
    expect(clampPage(0, 2)).toBe(0);
    expect(clampPage(1, 2)).toBe(1);
  });

  it('clamps an index past the last page to the last page', () => {
    expect(clampPage(5, 2)).toBe(1);
  });

  it('clamps a negative index to the first page', () => {
    expect(clampPage(-2, 3)).toBe(0);
  });

  it('returns 0 when there are no pages', () => {
    expect(clampPage(3, 0)).toBe(0);
    expect(clampPage(0, 0)).toBe(0);
  });

  it('floors a fractional index', () => {
    expect(clampPage(1.9, 3)).toBe(1);
  });
});

// estimateTooltip folds the projection basis + disclaimer into ONE sentence shown
// behind the ⓘ affordance, so "estimate(d)" is stated once (issue #38). PURE.
describe('estimateTooltip (hand-calculated)', () => {
  it('wraps the basis in the disclaimer sentence', () => {
    expect(estimateTooltip('last year this month; current 12-mo all-in rates')).toBe(
      'Estimated from last year this month; current 12-mo all-in rates. Not a real charge.'
    );
  });

  it('says "estimate" exactly once', () => {
    const t = estimateTooltip('trailing 3-mo average').toLowerCase();
    expect((t.match(/estimat/g) || []).length).toBe(1);
  });

  it('degrades gracefully when the basis is missing or blank', () => {
    expect(estimateTooltip(null)).toBe('Estimated. Not a real charge.');
    expect(estimateTooltip(undefined)).toBe('Estimated. Not a real charge.');
    expect(estimateTooltip('   ')).toBe('Estimated. Not a real charge.');
  });
});
