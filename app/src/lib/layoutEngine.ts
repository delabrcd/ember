// Pure layout-engine core (Phase E of the UI re-architecture, issue #73; RFC
// §3.3 + Decision 2). This is the math/placement half of the react-grid-layout
// (RGL) work, kept here — with NO React / RGL / DOM dependency — so it's
// hand-calc unit-tested in isolation, the same discipline cockpit.ts /
// dashboardLayout.ts / series.ts follow. The component (WidgetLayout) wires RGL
// + the ResizeObserver to these functions; the load-bearing arithmetic and the
// default-placement generation live HERE, not buried in the component.
//
// WHAT THIS OWNS (the Phase-E concrete types Phase D reserved as an opaque
// passthrough, RFC §3.4 `DashboardLayout.layouts`):
//   • `Breakpoint` / `Placement` — the serializable per-breakpoint widget
//     placements RGL consumes and we persist.
//   • `generateDefaultPlacements(...)` — reproduces TODAY's dashboard arrangement
//     (stat band on top, charts in the main area, bills rail on the right at lg)
//     from the Phase-D order/visibility, so an existing user with no saved
//     `layouts` opens to exactly today's view (acceptance #1).
//   • `mergePlacements(...)` — the migration safety net: a saved blob is repaired
//     against a freshly generated default (unknown widgets dropped, newly-added
//     widgets appended) so a round-trip never loses or corrupts placements.
//   • `computeFitRowHeight(...)` — the runtime no-scroll fit math (RFC §3.3),
//     replacing ConfigurableChart's `FILL_BODY_CLASSES` magic constant.

// The responsive breakpoints, widest → narrowest, mirroring RGL's keys. We use
// four (RFC §3.3: "lg ≥1280 / md / sm / xs"):
//   • lg  ≥1280 — the NO-SCROLL fit cockpit (the `xl` band the old layout pinned
//                 to the viewport). 12 columns.
//   • md  ≥ 996 — wide-but-not-fit; page scrolls (today's 768–1280 two-up band's
//                 upper half).
//   • sm  ≥ 768 — the old two-column band's lower half; page scrolls.
//   • xs  < 768 — MOBILE: a single column, page scrolls (today's <768 stack).
// The pixel thresholds match Tailwind's md/xl so the responsive behaviour lines
// up with the chrome's own breakpoints.
export type Breakpoint = 'lg' | 'md' | 'sm' | 'xs';

export const BREAKPOINTS: Record<Breakpoint, number> = { lg: 1280, md: 996, sm: 768, xs: 0 };

// Column count per breakpoint. lg uses a fine 12-col grid so the stat band (8
// cards) and the chart/bills split land cleanly; the narrower breakpoints use
// fewer columns, and xs is a SINGLE column so mobile collapses to a stack
// (acceptance #3). RGL maps a placement's `x`/`w` against these.
export const COLS: Record<Breakpoint, number> = { lg: 12, md: 8, sm: 6, xs: 1 };

// `lg` is the only breakpoint that runs the no-scroll fit (it's the old `xl`
// cockpit). Everything below it scrolls the page (today's behaviour). Exported
// so the component gates the fit math + viewport-lock on exactly this.
export const FIT_BREAKPOINT: Breakpoint = 'lg';

// One widget's placement in the grid — the serializable RGL layout-item shape
// (a subset; RGL ignores extra keys and we only persist these). `i` is the
// widget's registry type (e.g. 'stat:latestBill', 'chart:cost', 'panel:bills').
export interface Placement {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

// The persisted per-breakpoint placements — exactly RGL's Responsive `layouts`
// shape and the concrete type behind Phase D's opaque `DashboardLayout.layouts`
// passthrough (RFC §3.4). Partial because a breakpoint may be unset until first
// generated; the component fills any missing breakpoint from the generator.
export type Placements = Partial<Record<Breakpoint, Placement[]>>;

// The three widget categories the default generator lays out, in the order they
// stack on mobile and band on desktop. Charts are the variable-length middle.
export interface DefaultLayoutInput {
  // Visible stat-widget ids (already filtered + ordered by the host), e.g.
  // 'stat:latestBill'. Laid out as the top band.
  statIds: string[];
  // Visible chart-widget ids in the user's order, e.g. 'chart:cost'. The main
  // area, two-up at lg.
  chartIds: string[];
  // Panel widget ids (the bills rail), e.g. 'panel:bills'. The right rail at lg;
  // appended to the stack below charts at narrower breakpoints.
  panelIds: string[];
}

// ---------------------------------------------------------------------------
// Default-placement generator — reproduce TODAY's dashboard (acceptance #1).
// ---------------------------------------------------------------------------
//
// The arrangement we reproduce, per breakpoint:
//   • lg (12 cols, fit): a STAT BAND across the top (each card 12/8 = 1.5 cols,
//     so the 8 cards fill one row exactly as today's `lg:grid-cols-8`), then the
//     main split — CHARTS on the left (8 cols, two-up → a 2×N grid like the old
//     fit cockpit) and the BILLS rail on the right (4 cols), the rail spanning
//     the full chart height so it stretches like today.
//   • md (8 cols): stat band 4-up (2 cols each), charts two-up (4 cols each),
//     bills full-width below — the page scrolls.
//   • sm (6 cols): stats 3-up (2 cols), charts two-up (3 cols), bills full width.
//   • xs (1 col): EVERYTHING single-column in order stats → charts → bills, the
//     mobile stack (acceptance #3).
//
// Heights are in grid rows; the component's runtime rowHeight (computeFitRowHeight
// at lg, a fixed rowHeight below) turns rows into pixels. Stat cards are short
// (1 row); charts are tall (CHART_ROWS); the bills rail spans the chart block.

// Row heights (in grid units) for each widget kind. The grid uses a FINE row
// unit so the stat band and charts get proportional heights from one uniform
// rowHeight. The operator feedback (issue #73 iteration) is that several stat
// cards (carbon, vs-last-year, budget) were CLIPPED at the old 2-row default:
//   • the carbon card has a title + a big number + a THREE-fact sub line
//     ("≈ N gal gas · N tree-yrs · estimate") that wraps,
//   • vs-last-year shows two fuel deltas plus a sub line,
//   • budget has a title + headline + a progress BAR + a status sub line.
// At the fit rowHeight a single grid row is ~36–44px, so 2 rows (~80px) clipped
// the bar/wrapped sub lines. We bump a stat card to STAT_ROWS = 3 (~120px) so the
// tallest card (budget: ~16px title + ~30px stat + ~10px bar + ~16px sub +
// padding ≈ 96px) fits with headroom, and widen the per-widget default to w=3 so
// the three-fact carbon sub line and the two-fuel YoY row don't wrap awkwardly.
// A chart stays ~7 units (a comfortably tall plot).
const STAT_ROWS = 3;
const CHART_ROWS = 7;

// Total grid rows at lg in the DEFAULT layout: one stat band + two chart rows.
// This is the per-PAGE row budget the fit math sizes a row against so ONE page
// (stat band + two chart rows) fills the viewport with no scroll; anything past
// it spills onto page 2 via the pager (the no-scroll-paginate change, issue #73
// iteration). When the stat strip is PINNED it lives outside the paged area, so
// the per-page budget drops to just the two chart rows — see WidgetLayout.
export const DEFAULT_FIT_ROWS = STAT_ROWS + 2 * CHART_ROWS;

// The per-page row budget for the PAGED area below a PINNED stat strip: two chart
// rows (the stat band is pinned above and not paged). The fit math uses this when
// the strip is pinned so a page of charts still fills the viewport.
export const PINNED_PAGE_ROWS = 2 * CHART_ROWS;

// Lay a list of ids into a band of equal-width cells that wrap across `cols`,
// each `w` wide and `h` tall, starting at row `y0`. Returns the placements and
// the next free row. Pure helper for the per-breakpoint bands below.
function band(ids: string[], cols: number, w: number, h: number, y0: number): { items: Placement[]; nextY: number } {
  const perRow = Math.max(1, Math.floor(cols / w));
  const items: Placement[] = ids.map((i, idx) => ({
    i,
    x: (idx % perRow) * w,
    y: y0 + Math.floor(idx / perRow) * h,
    w,
    h,
  }));
  const rows = Math.ceil(ids.length / perRow) * h;
  return { items, nextY: y0 + (ids.length ? rows : 0) };
}

// Lay the stat cards as a FULL-WIDTH band that fills `cols` exactly. Each card
// gets floor(cols/n) columns; the first (cols % n) cards get +1 col, so the row
// of n cards spans all `cols` with no gap (reproducing today's even stat strip).
// If n > cols the cards wrap to further STAT_ROWS-tall rows. Pure helper.
function statBand(ids: string[], cols: number): { items: Placement[]; nextY: number } {
  const n = ids.length;
  if (n === 0) return { items: [], nextY: 0 };
  const perRow = Math.min(n, cols);
  const baseW = Math.floor(cols / perRow);
  const extra = cols % perRow; // the first `extra` cards in each row get +1 col
  const items: Placement[] = [];
  let x = 0;
  let y = 0;
  let col = 0; // index within the current row
  for (const i of ids) {
    if (col === perRow) {
      // wrap to the next band row
      col = 0;
      x = 0;
      y += STAT_ROWS;
    }
    const w = baseW + (col < extra ? 1 : 0);
    items.push({ i, x, y, w, h: STAT_ROWS });
    x += w;
    col += 1;
  }
  return { items, nextY: y + STAT_ROWS };
}

// Generate the lg (12-col) cockpit: stat band on top, charts left two-up, bills
// rail right spanning the chart block. This is the no-scroll fit arrangement.
function generateLg(input: DefaultLayoutInput): Placement[] {
  const cols = COLS.lg;
  const out: Placement[] = [];

  // Stat band: reproduce today's full-width 8-up row. 8 cards across 12 cols
  // isn't an even split, so we distribute the columns: each card gets
  // floor(cols/n), and the first (cols % n) cards get one extra column, so the
  // widths SUM TO `cols` exactly and the band fills the row edge-to-edge (no
  // ragged gap) — the faithful reproduction of `lg:grid-cols-8` (acceptance #1).
  // Cards wrap to a second row only if there are more than `cols` of them.
  const stat = statBand(input.statIds, cols);
  out.push(...stat.items);
  const afterStats = stat.nextY;

  // Charts: left block, 8 of 12 cols, two-up (each 4 cols) so they pair into rows
  // — the old 2×N fit cockpit. minH keeps a chart from being resized uselessly
  // short; minW keeps a chart at least half the chart block.
  const chartCols = 8;
  const chartW = 4;
  input.chartIds.forEach((i, idx) => {
    out.push({
      i,
      x: (idx % 2) * chartW,
      y: afterStats + Math.floor(idx / 2) * CHART_ROWS,
      w: chartW,
      h: CHART_ROWS,
      minW: 2,
      minH: 2,
    });
  });
  // How many chart rows the left block occupies (≥ two so the rail stretches the
  // cockpit even with 0–2 charts, matching today's two-row fit grid).
  const chartRowCount = Math.max(2, Math.ceil(input.chartIds.length / 2));
  const chartBlockH = chartRowCount * CHART_ROWS;

  // Bills rail: right block (12 − 8 = 4 cols), spanning the full chart block so
  // it stretches to the cockpit height exactly like today's `align stretch` rail.
  input.panelIds.forEach((i) => {
    out.push({ i, x: chartCols, y: afterStats, w: cols - chartCols, h: chartBlockH, minW: 2, minH: 2 });
  });
  return out;
}

// Generate a SCROLLING breakpoint (md / sm): stat band N-up, charts two-up,
// panels full-width below. The page scrolls so heights need not sum to a
// viewport — we just stack the bands.
function generateScrolling(input: DefaultLayoutInput, cols: number, statW: number, chartW: number): Placement[] {
  const out: Placement[] = [];
  const stat = band(input.statIds, cols, statW, STAT_ROWS, 0);
  out.push(...stat.items);

  let y = stat.nextY;
  input.chartIds.forEach((i, idx) => {
    out.push({
      i,
      x: (idx % 2) * chartW,
      y: y + Math.floor(idx / 2) * CHART_ROWS,
      w: chartW,
      h: CHART_ROWS,
      minW: 2,
      minH: 2,
    });
  });
  y += Math.ceil(Math.max(input.chartIds.length, 1) / 2) * CHART_ROWS;

  // Panels full-width below the charts.
  input.panelIds.forEach((i) => {
    out.push({ i, x: 0, y, w: cols, h: CHART_ROWS + 1, minW: 1, minH: 2 });
    y += CHART_ROWS + 1;
  });
  return out;
}

// Generate the xs (mobile) SINGLE-COLUMN stack: every widget full-width (w=1 of
// 1 col) in order stats → charts → panels, so mobile collapses to one column and
// scrolls (acceptance #3). Stat cards stay short; charts/panels are taller.
function generateXs(input: DefaultLayoutInput): Placement[] {
  const out: Placement[] = [];
  let y = 0;
  const push = (ids: string[], h: number) => {
    for (const i of ids) {
      out.push({ i, x: 0, y, w: 1, h, minW: 1, minH: 1 });
      y += h;
    }
  };
  push(input.statIds, STAT_ROWS);
  push(input.chartIds, CHART_ROWS);
  push(input.panelIds, CHART_ROWS);
  return out;
}

// Build the full per-breakpoint default placements that reproduce today's
// dashboard. PURE — unit-tested. The component calls this whenever a breakpoint
// has no saved placements (and on first load, persisting the result).
export function generateDefaultPlacements(input: DefaultLayoutInput): Placements {
  return {
    lg: generateLg(input),
    md: generateScrolling(input, COLS.md, 2, 4),
    sm: generateScrolling(input, COLS.sm, 2, 3),
    xs: generateXs(input),
  };
}

// ---------------------------------------------------------------------------
// Placement migration — the saved-blob safety net (RFC §6).
// ---------------------------------------------------------------------------
//
// A saved `layouts` blob can drift: a widget the user removed, a widget added
// since they saved (a new chart, a new stat card), or garbage. mergePlacements
// repairs each breakpoint against a freshly-generated default, the same
// drop-unknown / append-new discipline mergeOrder/mergeDashboardLayout use:
//   • keep a saved placement only if its widget id is still known (in the default
//     for that breakpoint),
//   • APPEND any known widget the save is missing, at the position the default
//     generator put it (so a newly-added chart shows up placed, not lost),
//   • a missing/garbage breakpoint falls back to the full default.
// PURE — unit-tested.
export function mergePlacements(saved: unknown, def: Placements): Placements {
  const out: Placements = {};
  for (const bp of Object.keys(def) as Breakpoint[]) {
    out[bp] = mergeOneBreakpoint(readSavedBp(saved, bp), def[bp] ?? []);
  }
  return out;
}

// Pull a saved breakpoint's placement array out of an untrusted blob, keeping
// only well-formed items (an `i` string + numeric x/y/w/h). Anything else is
// dropped here so mergeOneBreakpoint only sees plausible placements.
function readSavedBp(saved: unknown, bp: Breakpoint): Placement[] {
  if (!saved || typeof saved !== 'object') return [];
  const arr = (saved as Record<string, unknown>)[bp];
  if (!Array.isArray(arr)) return [];
  return arr.filter(isPlacement);
}

function isPlacement(v: unknown): v is Placement {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.i === 'string' &&
    typeof p.x === 'number' &&
    typeof p.y === 'number' &&
    typeof p.w === 'number' &&
    typeof p.h === 'number'
  );
}

// Merge one breakpoint: keep saved placements for still-known widgets (with
// their user-edited x/y/w/h), then append any known widget the save lacks at its
// default placement. Unknown saved ids (a removed/renamed widget) are dropped.
function mergeOneBreakpoint(saved: Placement[], def: Placement[]): Placement[] {
  const known = new Set(def.map((p) => p.i));
  const kept = saved.filter((p) => known.has(p.i));
  const have = new Set(kept.map((p) => p.i));
  const appended = def.filter((p) => !have.has(p.i));
  return [...kept, ...appended];
}

// ---------------------------------------------------------------------------
// No-scroll fit math — replaces ConfigurableChart's FILL_BODY_CLASSES constant.
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

export function computeFitRowHeight(opts: {
  viewportHeight: number;
  measuredChrome: number;
  rows: number;
  marginY: number;
}): number {
  const { viewportHeight, measuredChrome, marginY } = opts;
  const rows = Math.max(1, Math.floor(opts.rows));
  const available = viewportHeight - measuredChrome;
  const usable = available - marginY * (rows + 1);
  const rh = usable / rows;
  return Math.max(MIN_ROW_HEIGHT, rh);
}

// The maximum `y + h` across a breakpoint's placements = the row count the grid
// actually occupies. The fit math uses this (not the default constant) once a
// user has customized, so the no-scroll target tracks the real layout. Returns
// at least 1 so a degenerate/empty layout still divides safely. PURE.
export function placementRows(placements: Placement[] | undefined): number {
  if (!placements || placements.length === 0) return 1;
  return Math.max(1, ...placements.map((p) => p.y + p.h));
}

// ---------------------------------------------------------------------------
// PAGINATION — the "phone home screen" no-scroll fit (issue #73 iteration).
// ---------------------------------------------------------------------------
//
// The operator's rule: at the fit breakpoint the dashboard must NEVER scroll;
// any overflow is reached via PAGES (prev/next + dots), like a phone home
// screen — fill page 1, spill to page 2, etc. So instead of letting the grid
// region scroll, we:
//   1. decide how many grid ROWS fit one viewport page (`rowsPerPage`),
//   2. size the rowHeight so exactly that many rows FILL the page (no scroll),
//   3. partition the placements into pages by their row band (page = floor(y /
//      rowsPerPage)), clamping any tile so it sits WHOLLY within one page,
//   4. render only the active page (WidgetLayout translates a one-page-tall
//      clip container by -activePage * pageHeight).
// All the arithmetic is here, PURE + hand-calc unit-tested; WidgetLayout only
// wires the measured viewport/chrome to it and renders the active page + pager.

// How many whole grid rows fit in the available band, given a row height and the
// inter-row margin. RGL stacks a page of `n` rows as n*rowHeight + (n+1)*margin
// (a margin above the first row, below the last, and between each — we fold the
// container padding into the margin, the same assumption computeFitRowHeight
// makes). Solving n*rh + (n+1)*m ≤ available for n:
//   n ≤ (available − m) / (rh + m)
// We floor to whole rows and clamp to ≥1 so a tiny viewport still yields one row
// per page (it just shows a single squashed row rather than zero). PURE.
export function computeRowsPerPage(opts: {
  available: number; // viewportHeight − chrome − pinnedStripHeight (px)
  rowHeight: number; // px per grid row
  marginY: number; // px gap; (n+1) of them per page
}): number {
  const { available, marginY } = opts;
  const rowHeight = Math.max(MIN_ROW_HEIGHT, opts.rowHeight);
  const n = Math.floor((available - marginY) / (rowHeight + marginY));
  return Math.max(1, n);
}

// Given a fixed per-page row budget (`rowsPerPage`) and the available band, size
// the rowHeight so those rows EXACTLY fill the page → the active page is full-
// height with no scroll (the no-scroll guarantee, now per page rather than for
// the whole layout). This is computeFitRowHeight specialized to "the rows of one
// page", so the two stay in lock-step. PURE.
export function computePagedRowHeight(opts: {
  available: number; // the band one page fills (px)
  rowsPerPage: number;
  marginY: number;
}): number {
  return computeFitRowHeight({
    viewportHeight: opts.available,
    measuredChrome: 0,
    rows: opts.rowsPerPage,
    marginY: opts.marginY,
  });
}

// The pixel height of one page = rowsPerPage rows + their (rows+1) margins. This
// is the translate step WidgetLayout shifts the clip container by per page, and
// equals the available band when computePagedRowHeight sized the row. PURE.
export function pageHeightPx(opts: { rowsPerPage: number; rowHeight: number; marginY: number }): number {
  const rows = Math.max(1, Math.floor(opts.rowsPerPage));
  return rows * opts.rowHeight + (rows + 1) * opts.marginY;
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
// PURE — hand-calc unit-tested.
export function clampToPages(placements: Placement[], rowsPerPage: number): Placement[] {
  const rpp = Math.max(1, Math.floor(rowsPerPage));
  // Sort by row then column so earlier-in-reading-order tiles are re-banded
  // first; we copy so we never mutate the caller's array. We do NOT serialize
  // side-by-side tiles — a tile that already fits its band keeps its (x, y);
  // RGL's vertical compaction owns intra-page packing. We only move STRADDLERS.
  const sorted = [...placements].sort((a, b) => a.y - b.y || a.x - b.x);
  // For tiles we PUSH onto a later page, track the next free top row of that
  // band SO re-banded tiles don't pile on the same row; tiles that fit in place
  // never consult/advance this (they keep their column position untouched).
  const pushedNextRow = new Map<number, number>();
  const out: Placement[] = [];
  for (const p of sorted) {
    // A tile can be at most a whole page tall (so it fits within one band).
    const h = Math.min(p.h, rpp);
    const page = Math.floor(p.y / rpp);
    const fitsInBand = p.y + h <= (page + 1) * rpp;
    if (fitsInBand) {
      // Already wholly within its page band: leave it where it is.
      out.push({ ...p, h });
      continue;
    }
    // Straddler: push to the next page's band, at that band's next free row so
    // multiple pushed tiles stack rather than overlap. (RGL compaction tidies
    // any remaining same-column overlap on the next render, which re-saves.)
    const next = page + 1;
    const top = Math.max(next * rpp, pushedNextRow.get(next) ?? next * rpp);
    pushedNextRow.set(next, top + h);
    out.push({ ...p, y: top, h });
  }
  return out;
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
