import { describe, expect, it } from 'vitest';
import { mergeOrder } from '../src/lib/prefs';

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
