// Pure layout-engine BARREL (issue #157). The former 982-LOC monolith was split,
// along its existing comment-banner seams, into three pure modules under
// `lib/layout/`; this file re-exports them so the ~18 call sites in
// WidgetLayout.tsx (and Dashboard.tsx / dashboardLayout.ts / registry.tsx) keep
// importing from `@/lib/layoutEngine` unchanged. The split is a pure mechanical
// move — no function body changed — so the existing layoutEngine.test.ts is the
// behaviour-preserving proof.
//
//   • lib/layout/placements.ts — types + default-placement generators (the band
//     helpers, generateLg/Scrolling/Xs/Default/Strip, strip-key read/write).
//   • lib/layout/merge.ts      — migration/merge + structural equality
//     (mergePlacements, placementsEqual).
//   • lib/layout/pagination.ts — page fit + partition (computePageFit,
//     paginatePlacements, clampToPages, rebaseToLocal, pageCount, findFreeSlot,
//     MIN_ROW_HEIGHT) + clampPage (moved here from cockpit.ts).
//   • lib/layout/transforms.ts — the pure placement-blob transforms lifted out of
//     the components (add/remove/spacer/pin, spacer-fold, strip-repair,
//     persist-blob build). Imported directly where used; re-exported here too.

export type {
  Breakpoint,
  Placement,
  Placements,
  DefaultLayoutInput,
  WidgetMins,
} from './layout/placements';

export {
  BREAKPOINTS,
  COLS,
  FIT_BREAKPOINT,
  STRIP_KEY,
  STRIP_COLS,
  STAT_ROWS,
  CHART_ROWS,
  DEFAULT_FIT_ROWS,
  PINNED_PAGE_ROWS,
  WIDE_STAT_TYPES,
  readStrip,
  withStrip,
  generateStripPlacements,
  generateDefaultPlacements,
} from './layout/placements';

export { mergePlacements, placementsEqual } from './layout/merge';

export {
  MIN_ROW_HEIGHT,
  clampPage,
  findFreeSlot,
  computePageFit,
  rebaseToLocal,
  pageCount,
  clampToPages,
  paginatePlacements,
} from './layout/pagination';

export type { WidgetBox } from './layout/transforms';
export {
  removeFromPlacements,
  addToPlacements,
  addSpacer,
  togglePin,
  clampToPagesSafe,
  foldSpacerDefaults,
  repairStrip,
  buildPersistBlob,
} from './layout/transforms';
