import { describe, expect, it } from 'vitest';
import { mergeOrder, mergeRange } from '../src/lib/cockpit';
import { mergePrefs, DEFAULT_PREFS } from '../src/lib/prefs';

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

// mergePrefs carries the two projection display prefs (issue #71, splitting the
// single #69 toggle) through a localStorage round-trip: both default on for
// new/returning users, an explicit `false` must survive each (the `??` must not
// clobber it), and a saved LEGACY `showProjection` seeds both new keys so an
// existing user who hid the projection keeps it hidden everywhere.
describe('mergePrefs projection toggles (hand-calculated)', () => {
  it('defaults both projection toggles to true when nothing is saved', () => {
    expect(mergePrefs(null).showProjectionOnCharts).toBe(true);
    expect(mergePrefs(null).showProjectionCard).toBe(true);
    expect(mergePrefs({}).showProjectionOnCharts).toBe(true);
    expect(mergePrefs({}).showProjectionCard).toBe(true);
    expect(DEFAULT_PREFS.showProjectionOnCharts).toBe(true);
    expect(DEFAULT_PREFS.showProjectionCard).toBe(true);
  });

  it('preserves an explicit false for each toggle (no ?? clobber)', () => {
    expect(mergePrefs({ showProjectionOnCharts: false }).showProjectionOnCharts).toBe(false);
    // The other key is untouched and falls back to its default.
    expect(mergePrefs({ showProjectionOnCharts: false }).showProjectionCard).toBe(true);
    expect(mergePrefs({ showProjectionCard: false }).showProjectionCard).toBe(false);
    expect(mergePrefs({ showProjectionCard: false }).showProjectionOnCharts).toBe(true);
  });

  it('preserves an explicit true for each toggle', () => {
    expect(mergePrefs({ showProjectionOnCharts: true }).showProjectionOnCharts).toBe(true);
    expect(mergePrefs({ showProjectionCard: true }).showProjectionCard).toBe(true);
  });

  it('migrates a legacy showProjection=false into BOTH new toggles', () => {
    const m = mergePrefs({ showProjection: false });
    expect(m.showProjectionOnCharts).toBe(false);
    expect(m.showProjectionCard).toBe(false);
  });

  it('migrates a legacy showProjection=true into BOTH new toggles', () => {
    const m = mergePrefs({ showProjection: true });
    expect(m.showProjectionOnCharts).toBe(true);
    expect(m.showProjectionCard).toBe(true);
  });

  it('lets a new key override the legacy value when both are present', () => {
    // A user mid-migration who explicitly set one new toggle: it wins over legacy.
    const m = mergePrefs({ showProjection: false, showProjectionCard: true });
    expect(m.showProjectionOnCharts).toBe(false); // from legacy
    expect(m.showProjectionCard).toBe(true); // explicit new key wins
  });
});

// density (issue #2 → retired): the 'comfortable' page-scrolling layout was
// dropped once Customize mode + the paginated fit layout superseded it. The pref
// is kept for localStorage compatibility but is effectively a constant — mergePrefs
// migrates ANY persisted value (including a returning user's 'comfortable') to 'fit'
// so nobody is left in the dead layout.
describe('mergePrefs density (hand-calculated)', () => {
  it("defaults to 'fit' when nothing is saved", () => {
    expect(mergePrefs(null).density).toBe('fit');
    expect(mergePrefs({}).density).toBe('fit');
    expect(DEFAULT_PREFS.density).toBe('fit');
  });

  it("migrates a persisted 'comfortable' to 'fit'", () => {
    expect(mergePrefs({ density: 'comfortable' as never }).density).toBe('fit');
  });

  it("keeps a persisted 'fit' as 'fit'", () => {
    expect(mergePrefs({ density: 'fit' }).density).toBe('fit');
  });
});

// rateCardMode (compact-stat-cards iteration): the rate cards' flick choice rides
// the same display prefs with per-key `??` back-compat — default 'avg' (today's
// behavior) for new/returning users, an explicit valid value survives, garbage falls
// back to the default.
describe('mergePrefs rateCardMode (hand-calculated)', () => {
  it("defaults to 'avg' when nothing is saved", () => {
    expect(mergePrefs(null).rateCardMode).toBe('avg');
    expect(mergePrefs({}).rateCardMode).toBe('avg');
    expect(DEFAULT_PREFS.rateCardMode).toBe('avg');
  });

  it('preserves an explicit saved mode', () => {
    expect(mergePrefs({ rateCardMode: 'current' }).rateCardMode).toBe('current');
    expect(mergePrefs({ rateCardMode: 'avg' }).rateCardMode).toBe('avg');
  });

  it('falls back to the default for a garbage value', () => {
    expect(mergePrefs({ rateCardMode: 'bogus' as never }).rateCardMode).toBe('avg');
  });
});
