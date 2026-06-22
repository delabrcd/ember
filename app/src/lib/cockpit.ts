// Pure cockpit helpers — pagination + prefs-merge logic with no DB/React/
// localStorage dependency, so they're unit-testable in isolation. The cockpit
// UI lives in `lib/prefs.tsx`; this module is the number/array core it leans on.

import { DEFAULT_RANGE, migrateRangeMonths, type RangePref, type RangePreset } from './range';

// `clampPage` moved to lib/layout/pagination.ts (issue #157) — re-exported here so
// existing call sites (the cockpit, paginate.test.ts) that import it from cockpit
// keep working unchanged.
export { clampPage } from './layout/pagination';

// Merge a saved chart order with the current default order. Keeps the user's
// existing order/positions but APPENDS any chart ids that didn't exist when they
// last saved (e.g. the weather/degree-days/normalized charts added later) and
// drops ids that no longer exist. PURE — unit-tested. Without this, charts added
// after a user's prefs were first written never appear for them. Exported for tests.
export function mergeOrder(savedOrder: string[] | undefined, defaultOrder: string[]): string[] {
  const known = new Set(defaultOrder);
  const saved = (savedOrder ?? []).filter((id) => known.has(id));
  const seen = new Set(saved);
  const appended = defaultOrder.filter((id) => !seen.has(id));
  return [...saved, ...appended];
}

// The saved blob may predate the RangePref model (issue #24): older prefs carry
// a `rangeMonths` number instead of a `range` object. Resolve the range from
// whichever is present — a real `range` wins; otherwise migrate `rangeMonths`;
// otherwise the default. A partial/garbage `range` is repaired field-by-field.
// PURE — unit-tested. The `rangeMonths` legacy field is read here but never
// written back, so it ages out of a returning user's stored prefs.
const VALID_PRESETS: RangePreset[] = ['all', 'ytd', '12mo', '24mo', '36mo', 'custom'];

export function mergeRange(saved: { range?: unknown; rangeMonths?: number } | null | undefined): RangePref {
  const r = saved?.range as Partial<RangePref> | undefined;
  if (r && typeof r === 'object' && typeof r.preset === 'string' && VALID_PRESETS.includes(r.preset as RangePreset)) {
    return {
      preset: r.preset as RangePreset,
      fromYm: typeof r.fromYm === 'number' ? r.fromYm : null,
      toYm: typeof r.toYm === 'number' ? r.toYm : null,
    };
  }
  if (saved && typeof saved.rangeMonths === 'number') return migrateRangeMonths(saved.rangeMonths);
  return { ...DEFAULT_RANGE };
}
