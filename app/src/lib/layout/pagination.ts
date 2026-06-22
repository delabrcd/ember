// Page fit + partition math (split out of the former monolithic
// lib/layoutEngine.ts, issue #157). PURE — no React / RGL / DOM. The runtime
// no-scroll fit derivation, the page partition, and the free-slot scan all live
// here so they're hand-calc unit-tested in isolation; WidgetLayout only wires the
// measured viewport/chrome to these functions.

import type { Placement } from './placements';

// ---------------------------------------------------------------------------
// No-scroll fit math — derives the grid rowHeight from the measured chrome.
// ---------------------------------------------------------------------------
//
// THE FORMULA (RFC §3.3). At lg we pin the page to the viewport and want the
// grid's total height to equal the space left under the fixed chrome, so the
// page never scrolls:
//
//   available  = viewportHeight − measuredChrome
//   rowHeight  = (available − marginY*(rows + 1)) / rows
//
// where:
//   • viewportHeight  — window.innerHeight (px).
//   • measuredChrome  — the runtime-measured height of everything ABOVE the grid
//     (header + banners + range/schedule strip + page padding), via a
//     ResizeObserver in WidgetLayout. This is the value that used to be the
//     hand-tuned `22.5rem` constant; measuring it kills the fragility (RFC §6).
//   • rows            — the grid's row count (DEFAULT_FIT_ROWS for the default
//     cockpit; the live max-row of the layout once customized).
//   • marginY         — RGL's vertical gap between rows; there are `rows + 1`
//     gaps (RGL adds the margin above the first row and below the last, plus
//     containerPadding top/bottom — we fold the container padding into marginY by
//     passing equal values, the common RGL setup).
//
// Result: gridHeight = rows*rowHeight + (rows+1)*marginY = available, so
// chrome + gridHeight = viewportHeight exactly → no page scroll. We clamp
// rowHeight to a sane floor so a tiny viewport (or a mis-measured chrome) can't
// produce a zero/negative height that collapses Recharts to nothing (it would
// just scroll a little instead, which is acceptable degradation). PURE —
// unit-tested.
export const MIN_ROW_HEIGHT = 24;

// Wrap/clamp a desired page index to the valid range for a given page count, so
// the cockpit's prev/next arrows can never select an out-of-range page even if
// the visible-chart set shrinks underneath the active index. Returns 0 when there
// are no pages. PURE — unit-tested. (Moved here from cockpit.ts in issue #157 —
// cockpit.ts re-exports it for back-compat.)
export function clampPage(index: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(Math.max(0, Math.floor(index)), pageCount - 1);
}

// Do two boxes (x/y/w/h cells) overlap on the grid? Used to find a collision-free
// drop slot for a newly-added widget. Half-open intervals — tiles that merely
// touch edge-to-edge ([0,6) and [6,12)) do NOT overlap. PURE.
function boxesOverlap(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number }
): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

// Find a free top-left cell for a new w×h tile on a `cols`-wide grid that already
// holds `existing` placements, scanning rows top-to-bottom then columns left-to-
// right (reading order). Returns the first {x, y} where the tile fits without
// overlapping anything. RGL runs with compactType="vertical" + preventCollision=
// false, so a tile dropped onto an occupied spot would shove others around; to add
// a widget cleanly we instead pre-compute an empty patch and drop it there. We
// always find a slot: a row below every existing tile is guaranteed empty, so the
// scan terminates there at worst. PURE — hand-calc unit-tested.
export function findFreeSlot(
  existing: Placement[],
  size: { w: number; h: number },
  cols: number
): { x: number; y: number } {
  const w = Math.min(Math.max(1, size.w), cols);
  const h = Math.max(1, size.h);
  // Scan no further down than one row past the lowest existing tile — placing the
  // new tile there is always collision-free (nothing lives below the layout).
  const maxY = existing.length === 0 ? 0 : Math.max(...existing.map((p) => p.y + p.h));
  for (let y = 0; y <= maxY; y++) {
    for (let x = 0; x + w <= cols; x++) {
      const candidate = { x, y, w, h };
      if (!existing.some((p) => boxesOverlap(candidate, p))) return { x, y };
    }
  }
  // Fallback (only reached if cols < w, which we already clamped): stack below all.
  return { x: 0, y: maxY };
}

// ---------------------------------------------------------------------------
// PAGINATION — the "phone home screen" no-scroll fit (issue #73 iteration).
// ---------------------------------------------------------------------------
//
// The operator's rule: at the fit breakpoint the dashboard must NEVER scroll;
// any overflow is reached via PAGES (prev/next + dots), like a phone home
// screen — fill page 1, spill to page 2, etc. So instead of letting the grid
// region scroll, we:
//   1. derive (R rows-per-page, rowHeight) from the measured band so exactly R
//      rows FILL one viewport page with no scroll (`computePageFit`),
//   2. partition the placements into pages by their row band (page = floor(y /
//      rowsPerPage)), clamping any tile so it sits WHOLLY within one page,
//   3. render only the active page as its OWN bounded grid — WidgetLayout mounts
//      just that page's widgets, rebased to local y=0 (`rebaseToLocal`), in an RGL
//      of height exactly the band with maxRows = R. NO clip window, NO translate:
//      a tile can't be sheared at a boundary because the page IS the grid.
// All the arithmetic is here, PURE + hand-calc unit-tested; WidgetLayout only
// wires the measured viewport/chrome to it and renders the active page + pager.

// ---------------------------------------------------------------------------
// THE KEYSTONE FIT DERIVATION (issue #73 root-cause architecture fix).
// ---------------------------------------------------------------------------
//
// The OLD model laid out ONE tall RGL canvas (every page stacked) and, in view
// mode, revealed one page via a fixed-height clip window TRANSLATED by
// −page*pageStep. That clip/translate machinery is the root of the layout bugs:
//   • a tile straddling a page boundary got visually CLIPPED (graph bottoms cut
//     off, the bills top sheared), because the clip window had a hard pixel edge
//     the tile crossed; and
//   • `pageH` (clip height), `pageStep` (translate step) and RGL's real row-band
//     spacing kept disagreeing by a margin here or there, so pages drifted, left
//     dead bands, or over-counted the page total.
//
// THE FIX — each page is its OWN bounded grid. WidgetLayout now renders ONLY the
// active page's widgets, rebased to local y=0, in an RGL of height EXACTLY the
// available band with `maxRows = R`. There is no clip and no translate, so a tile
// physically cannot be sheared at a boundary: the page IS the grid and it fits.
//
// `computePageFit` is the single source for (R, rowHeight) from the measured
// band. It honours a DESIGN row budget (a 2×2 of charts → 2*CHART_ROWS), but
// ADAPTS rather than scrolls: if the band is too short to give those rows a
// readable height (rowHeight would fall below MIN_ROW_HEIGHT), it reduces R until
// the rows fit at ≥ the floor. The returned rowHeight then makes exactly R rows
// FILL the band: R*rowHeight + (R+1)*margin == availH, so the page is
// viewport-tall with no scroll.
//
// `rowQuantum` keeps the page budget a MULTIPLE of one widget-row's height (e.g.
// CHART_ROWS) when adapting, so a page always holds WHOLE chart rows — never a
// partial row that would straddle a boundary and leave a wasted empty band on the
// next page (the bug the old clip/translate model also hit). We step R DOWN by the
// quantum (a 2×2 → one chart row → a 1×2), and only below a single chart row drop
// to a sub-quantum R for a pathologically short viewport. We never grow R past the
// design budget — the common laptop case must land on the intended one-page
// cockpit, not squeeze a partial extra row in. PURE — hand-calc unit-tested.
export function computePageFit(opts: {
  availH: number; // the measured band one page must fill (px)
  designRows: number; // the desired rows-per-page (e.g. 2*CHART_ROWS for a 2×2)
  marginY: number; // RGL's inter-row gap (also the container padding)
  rowQuantum?: number; // keep R a multiple of this (e.g. CHART_ROWS) — default 1
}): { rows: number; rowHeight: number } {
  const { availH, marginY } = opts;
  const design = Math.max(1, Math.floor(opts.designRows));
  const quantum = Math.max(1, Math.floor(opts.rowQuantum ?? 1));
  // The exact fill height for a given R: the row that makes R rows fill the band
  // with no scroll, (availH − (R+1)*margin)/R.
  const fillHeight = (rows: number) => (availH - (rows + 1) * marginY) / rows;
  // 1) Step DOWN by whole quanta from the design budget (snapped to a quantum
  //    multiple), accepting the first (largest) whose fill height clears the
  //    readable floor. Whole-quantum pages keep the 2×2 / 1×2 aligned to page
  //    boundaries, so no partial chart row straddles → no wasted empty band.
  const snapped = design - (design % quantum);
  for (let rows = Math.max(quantum, snapped); rows >= quantum; rows -= quantum) {
    const rh = fillHeight(rows);
    if (rh >= MIN_ROW_HEIGHT) return { rows, rowHeight: rh };
  }
  // 2) Even one quantum (a single chart row) can't reach the floor → fall to a
  //    sub-quantum R so SOMETHING still fills the band; step down to 1, clamping
  //    the last row to the floor (it then scrolls a hair — the documented graceful
  //    degradation on a pathologically short viewport).
  for (let rows = quantum - 1; rows >= 1; rows--) {
    const rh = fillHeight(rows);
    if (rh >= MIN_ROW_HEIGHT || rows === 1) {
      return { rows, rowHeight: Math.max(MIN_ROW_HEIGHT, rh) };
    }
  }
  // Unreachable (the loops always return); keeps TS exhaustive.
  return { rows: 1, rowHeight: MIN_ROW_HEIGHT };
}

// Rebase a single page's placements so the page's TOP row becomes local y=0 — the
// page's own grid starts at the origin (no leftover offset from the pages above
// it). The page partition (paginatePlacements) keys a tile to a page by its
// GLOBAL row band; once we render that page as a standalone grid we subtract the
// band's base row so the tile sits at its in-page position. Idempotent on a page
// whose min-y is already 0. PURE — hand-calc unit-tested.
export function rebaseToLocal(page: Placement[], rowsPerPage: number): Placement[] {
  const rpp = Math.max(1, Math.floor(rowsPerPage));
  if (page.length === 0) return page;
  // The page's base row is the band of its top-most tile (floor(minY / rpp) *
  // rpp) — NOT just min(y), so a page whose first tile starts a few rows into its
  // band keeps that intra-band offset (the gap above it survives the round-trip).
  const minY = Math.min(...page.map((p) => p.y));
  const base = Math.floor(minY / rpp) * rpp;
  return base > 0 ? page.map((p) => ({ ...p, y: p.y - base })) : page;
}

// How many pages a set of placements spans, given the per-page row budget: the
// last occupied row band + 1. Empty layout = a single (empty) page so the grid
// always renders something. PURE.
export function pageCount(placements: Placement[] | undefined, rowsPerPage: number): number {
  const rpp = Math.max(1, Math.floor(rowsPerPage));
  if (!placements || placements.length === 0) return 1;
  const lastBottom = Math.max(0, ...placements.map((p) => p.y + p.h));
  // A tile occupying rows [y, y+h) ends at row (y+h-1); its page is that row's
  // band. ceil(lastBottom / rpp) is the page count (a tile ending exactly on a
  // band boundary doesn't start a new page).
  return Math.max(1, Math.ceil(lastBottom / rpp));
}

// Repair placements so NO tile straddles a page boundary (the phone-home-screen
// rule: a tile sits wholly within one page's row band). For each tile we find
// the page its TOP row lands on (floor(y / rpp)); if the tile would spill past
// that page's last row, we PUSH it down to the top of the next page (re-banding
// it) — and a tile taller than a whole page is CLAMPED to the page height so it
// can still fit. We process in (y, x) order and track each page-band's next free
// row so re-banded tiles stack instead of overlapping. This runs at generation
// AND on a saved-blob repair, so a customized layout still paginates cleanly.
//
// IDEMPOTENT (issue #73): applying clampToPages to its own output yields the same
// result — every tile is left wholly within a band, and we EMIT in the caller's
// original array order (not the internal processing order) so the array shape is
// stable too. That fixed-point property is what lets WidgetLayout's persist →
// re-feed-RGL → onLayoutChange round-trip settle instead of looping (React #185).
// PURE — hand-calc unit-tested.
export function clampToPages(placements: Placement[], rowsPerPage: number): Placement[] {
  const rpp = Math.max(1, Math.floor(rowsPerPage));
  // Process STRADDLERS in (y, x) reading order so earlier tiles are re-banded
  // first and later ones stack below them — but remember each tile's ORIGINAL
  // index so we can emit the result in the caller's order (idempotency: a second
  // pass must not reshuffle the array). We do NOT serialize side-by-side tiles —
  // a tile that already fits its band keeps its (x, y); RGL's vertical compaction
  // owns intra-page packing. We only move straddlers.
  const order = placements.map((p, idx) => ({ p, idx })).sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x);
  // For tiles we PUSH onto a later page, track the next free top row of that
  // band SO re-banded tiles don't pile on the same row; tiles that fit in place
  // never consult/advance this (they keep their column position untouched).
  const pushedNextRow = new Map<number, number>();
  const byIndex: Placement[] = new Array(placements.length);
  for (const { p, idx } of order) {
    // A tile can be at most a whole page tall (so it fits within one band).
    const h = Math.min(p.h, rpp);
    const page = Math.floor(p.y / rpp);
    const fitsInBand = p.y + h <= (page + 1) * rpp;
    if (fitsInBand) {
      // Already wholly within its page band: leave it where it is.
      byIndex[idx] = { ...p, h };
      continue;
    }
    // Straddler: push to a later page's band, at that band's next free row so
    // multiple pushed tiles stack rather than overlap. We advance band-by-band
    // until the tile sits WHOLLY within one band — a single band may already be
    // partly filled by earlier pushed tiles (so this tile's top + h would overrun
    // it), in which case we move on to the next band. Settling the tile fully in
    // ONE pass is what makes clampToPages idempotent: a second application finds
    // every tile already within its band and changes nothing.
    let band = page + 1;
    let top = Math.max(band * rpp, pushedNextRow.get(band) ?? band * rpp);
    while (top + h > (band + 1) * rpp) {
      band += 1;
      top = Math.max(band * rpp, pushedNextRow.get(band) ?? band * rpp);
    }
    pushedNextRow.set(band, top + h);
    byIndex[idx] = { ...p, y: top, h };
  }
  return byIndex;
}

// Partition placements into pages by their (clamped) row band: page index =
// floor(y / rowsPerPage). Returns a dense array of `pageCount` pages (each an
// array of that page's placements, possibly empty). The caller clamps tiles
// FIRST (clampToPages) so no tile straddles a boundary; here we just bucket by
// band. PURE — hand-calc unit-tested.
export function paginatePlacements(placements: Placement[], rowsPerPage: number): Placement[][] {
  const rpp = Math.max(1, Math.floor(rowsPerPage));
  const clamped = clampToPages(placements, rpp);
  const count = pageCount(clamped, rpp);
  const pages: Placement[][] = Array.from({ length: count }, () => []);
  for (const p of clamped) {
    const page = Math.floor(p.y / rpp);
    (pages[page] ?? pages[count - 1]).push(p);
  }
  return pages;
}
