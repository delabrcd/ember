import { describe, expect, it } from 'vitest';
import { mergeOrder, mergeRange } from '../src/lib/cockpit';

// mergeOrder keeps the user's saved chart order but appends charts that were
// added to the app AFTER they last saved their prefs (the bug that hid the
// weather/degree-days/normalized charts for the existing operator), and drops
// ids that no longer exist.
describe('mergeOrder (hand-calculated)', () => {
  const def = ['usage', 'cost', 'rates', 'weather', 'degreeDays', 'normalized'];

  it('appends newly-added charts a stale saved order is missing', () => {
    // Saved order predates the weather charts.
    expect(mergeOrder(['usage', 'cost', 'rates'], def)).toEqual([
      'usage', 'cost', 'rates', 'weather', 'degreeDays', 'normalized',
    ]);
  });

  it("preserves the user's custom ordering of the charts they already had", () => {
    expect(mergeOrder(['rates', 'usage', 'cost'], def)).toEqual([
      'rates', 'usage', 'cost', 'weather', 'degreeDays', 'normalized',
    ]);
  });

  it('drops ids that are no longer known charts', () => {
    expect(mergeOrder(['usage', 'legacyChart', 'cost'], def)).toEqual([
      'usage', 'cost', 'rates', 'weather', 'degreeDays', 'normalized',
    ]);
  });

  it('returns the full default order when nothing was saved', () => {
    expect(mergeOrder(undefined, def)).toEqual(def);
    expect(mergeOrder([], def)).toEqual(def);
  });

  it('keeps a complete, already-current order unchanged', () => {
    expect(mergeOrder([...def], def)).toEqual(def);
  });
});

// mergeRange migrates a returning user's saved prefs to the RangePref model
// (issue #24): a real `range` wins, an old `rangeMonths` number is migrated, and
// missing/garbage falls back to the "all" default.
describe('mergeRange (hand-calculated)', () => {
  it('passes through a valid new-style range', () => {
    expect(mergeRange({ range: { preset: 'custom', fromYm: 202301, toYm: 202312 } })).toEqual({
      preset: 'custom',
      fromYm: 202301,
      toYm: 202312,
    });
  });

  it('migrates a stale rangeMonths number to a preset', () => {
    expect(mergeRange({ rangeMonths: 12 })).toEqual({ preset: '12mo', fromYm: null, toYm: null });
    expect(mergeRange({ rangeMonths: 0 })).toEqual({ preset: 'all', fromYm: null, toYm: null });
  });

  it('defaults to "all" when nothing is saved', () => {
    expect(mergeRange(null)).toEqual({ preset: 'all', fromYm: null, toYm: null });
    expect(mergeRange({})).toEqual({ preset: 'all', fromYm: null, toYm: null });
  });

  it('repairs a partial/garbage range field-by-field', () => {
    expect(mergeRange({ range: { preset: 'bogus' } as never })).toEqual({ preset: 'all', fromYm: null, toYm: null });
    expect(mergeRange({ range: { preset: 'custom', fromYm: 202305 } as never })).toEqual({
      preset: 'custom',
      fromYm: 202305,
      toYm: null,
    });
  });
});
