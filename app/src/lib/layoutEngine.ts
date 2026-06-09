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
//   • `computeFitRowHeight(...)` — the runtime no-scroll fit math (RFC §3.3): it
//     derives the grid rowHeight from the measured chrome so the page fills the
//     viewport without scrolling.

// The responsive breakpoints, widest → narrowest, mirroring RGL's keys. We use
// four (RFC §3.3: "lg ≥1280 / md / sm / xs"):
//   • lg  ≥1232 — the NO-SCROLL fit cockpit (the `xl` band the old layout pinned
//                 to the viewport). 12 columns.
//   • md  ≥ 996 — wide-but-not-fit; page scrolls (today's 768–1280 two-up band's
//                 upper half).
//   • sm  ≥ 768 — the old two-column band's lower half; page scrolls.
//   • xs  < 768 — MOBILE: a single column, page scrolls (today's <768 stack).
//
// THE lg THRESHOLD IS 1232, NOT 1280 (the page-lock boundary fix): the chrome
// pins the page to the viewport at Tailwind's `xl` (≥1280 VIEWPORT px), but RGL's
// WidthProvider selects the breakpoint from the grid CONTAINER width, which is the
// viewport minus the shell's horizontal padding (`sm:px-5` = 40px) — so a 1280
// viewport gives a ~1240px container. With lg at 1280 the 1280-viewport case fell
// to `md` and the grid scrolled instead of paginating (the page-lock and the fit
// grid disagreed at exactly the boundary). 1232 < 1240 ensures a 1280 viewport's
// container lands on lg/fit, so the no-scroll paginated cockpit engages exactly
// where the page lock does. md still covers 996–1231 container widths.
export type Breakpoint = 'lg' | 'md' | 'sm' | 'xs';

export const BREAKPOINTS: Record<Breakpoint, number> = { lg: 1232, md: 996, sm: 768, xs: 0 };

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
//
// PINNED-STRIP PLACEMENTS (issue #73 iteration — the customizable pinned strip):
// the pinned stat strip is now its OWN editable RGL grid, with its own placements.
// They ride this SAME blob under a reserved key (`STRIP_KEY` below) — NOT a new
// `DashboardLayout` field, so there's no schema change: the strip layout persists
// through the same `layouts` PUT as the paged grid. The key is NOT a Breakpoint
// (it's a fixed `__strip`), so the per-breakpoint paths (mergePlacements over the
// four real breakpoints, the paged-grid build) never see it; the component reads
// it out explicitly via `readStrip` / writes it via `withStrip`.
export type Placements = Partial<Record<Breakpoint, Placement[]>> & {
  // The pinned strip's own placements (a single 12-col band of stat cards). Stored
  // under a reserved, non-breakpoint key so it round-trips with the rest of the
  // layout blob without a schema change. Absent until the strip is first generated.
  [STRIP_KEY]?: Placement[];
};

// The reserved (non-breakpoint) key under which the pinned strip's placements live
// in the `Placements` blob. A double-underscore prefix so it can never collide
// with a real breakpoint id ('lg'/'md'/'sm'/'xs').
export const STRIP_KEY = '__strip' as const;

// The pinned strip is its OWN grid, separate from the 12-col page grid. We use a
// FINE 24-col band (CHANGE 1, the even-strip iteration) so the 8 default stat cards
// tile EVENLY: 24 / 8 = 3 cols each, all equal width, summing to 24 with no
// remainder — the operator's "evenly spaced" ask. (At 12 cols, 12 % 8 = 4 forced a
// mixed 4×w=2 + 4×w=1 distribution, which read as unbalanced.) 24 is divisible by
// the common card counts (8→3, 6→4, 4→6, 3→8, 2→12), so the strip stays even as
// cards are added/removed. Exported for the component's strip RGL.
export const STRIP_COLS = 24;

// Read the strip placements out of a (possibly absent) blob — never the
// per-breakpoint paths, which must ignore the reserved key. PURE.
export function readStrip(p: Placements | undefined): Placement[] | undefined {
  const arr = p?.[STRIP_KEY];
  return Array.isArray(arr) ? arr : undefined;
}

// Return a copy of the blob with the strip placements set under the reserved key,
// leaving every real breakpoint untouched. PURE.
export function withStrip(p: Placements, strip: Placement[]): Placements {
  return { ...p, [STRIP_KEY]: strip };
}

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
  // Per-widget minimum grid bounds, keyed by widget id (registry `defaultSize`'s
  // minW/minH). THREADED IN from the caller (WidgetLayout/Dashboard, which own the
  // registry) so this module stays pure + registry-free. The DEFAULT-PLACEMENT
  // INVARIANT (issue #73 fix): no emitted default placement may have `w < minW` or
  // `h < minH` for its widget — otherwise the factory default is below the floor
  // RGL enforces on resize, so it crushes the tile (content clips) and the user
  // can never recreate it without resetting. Optional so a caller without the
  // registry (a test of pure geometry) can omit it; absent → no min floor, the
  // legacy behaviour (and emitted placements carry no minW/minH stamp).
  mins?: WidgetMins;
}

// A per-widget-id min-bounds lookup the caller supplies to the generator. Keeps
// layoutEngine pure: the registry-derived mins are passed in, never imported.
export type WidgetMins = Record<string, { minW?: number; minH?: number } | undefined>;

// The min columns a widget id needs, from the supplied lookup (≥1, default 1 when
// the widget or its minW is absent). PURE.
function minWOf(id: string, mins: WidgetMins | undefined): number {
  return Math.max(1, mins?.[id]?.minW ?? 1);
}

// The min rows a widget id needs, from the supplied lookup (≥1, default 1). PURE.
function minHOf(id: string, mins: WidgetMins | undefined): number {
  return Math.max(1, mins?.[id]?.minH ?? 1);
}

// Stamp a placement with its widget's min bounds (only when the lookup provides
// them, so a registry-free caller's placements stay un-stamped — matching the
// legacy shape). The DEFAULT-PLACEMENT INVARIANT also lifts `w`/`h` UP to the min
// when the requested size is below it, so a default tile and a user-resized tile
// share the same floor (acceptance: a fresh default is never sub-min). PURE.
function withMins(p: Placement, mins: WidgetMins | undefined): Placement {
  const entry = mins?.[p.i];
  if (!entry) return p;
  const out: Placement = { ...p };
  if (typeof entry.minW === 'number') {
    out.minW = entry.minW;
    if (out.w < entry.minW) out.w = entry.minW;
  }
  if (typeof entry.minH === 'number') {
    out.minH = entry.minH;
    if (out.h < entry.minH) out.h = entry.minH;
  }
  return out;
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
// rowHeight.
//
// COMPACT STAT CARDS (compact-stat-cards iteration). The operator's ask: the
// default pinned strip took ~half the screen (two card-rows of tall cards); it
// should be a SINGLE compact row. Two changes deliver that — (1) the stat card's
// minW is now 1, so all 8 cards lay out in ONE row of the 12-col strip (was minW=2
// → 8 cards forced onto two card-rows), and (2) the card body is trimmed to just
// the brief title + the headline value (the old sub/detail line moved into the ⓘ
// tooltip), so a card needs only ~2 grid rows of height. We drop STAT_ROWS 3 → 2:
// EVERY card (title + headline = 66px) fits in 2 strip rows (2*30 + 8 = 68px),
// INCLUDING the budget card — its ~6px progress bar now fits WITHIN that shared
// height (visual-uniformity pass) instead of reserving an extra row, so all cards
// derive minH=2 via cardFit and the strip is one UNIFORM-height compact row (~68px
// at STRIP_ROW_HEIGHT=30) instead of the old budget-driven ~106px / ~208px blocks.
// A chart stays ~7 units (a comfortably tall plot).
export const STAT_ROWS = 2;
// Exported so WidgetLayout can pass it as computePageFit's `rowQuantum` — keeping
// each fit page a whole number of CHART rows so the 2×2 aligns to page boundaries
// (no partial chart row straddling a page → no wasted empty band).
export const CHART_ROWS = 7;

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
//
// MIN-FLOOR (issue #73 fix): the requested `w` is capped so a card never gets
// fewer than its widest member's `minW` columns — `perRow` is bounded by
// floor(cols / maxMinW), and each emitted tile is stamped with (and lifted to) its
// own min via withMins. So a default tile is never below the floor RGL enforces.
function band(
  ids: string[],
  cols: number,
  w: number,
  h: number,
  y0: number,
  mins?: WidgetMins
): { items: Placement[]; nextY: number } {
  if (ids.length === 0) return { items: [], nextY: y0 };
  // Each card needs at least the widest member's minW columns; cap the per-row
  // count so no card falls below it (cards-per-row ≤ floor(cols / maxMinW)).
  const maxMinW = Math.max(1, ...ids.map((i) => minWOf(i, mins)));
  const cellW = Math.max(w, maxMinW);
  const perRow = Math.max(1, Math.floor(cols / cellW));
  const items: Placement[] = ids.map((i, idx) =>
    withMins(
      {
        i,
        x: (idx % perRow) * cellW,
        y: y0 + Math.floor(idx / perRow) * h,
        w: cellW,
        h,
      },
      mins
    )
  );
  const rows = Math.ceil(ids.length / perRow) * h;
  return { items, nextY: y0 + rows };
}

// Lay the stat cards as a FULL-WIDTH band that fills `cols` exactly, wrapping so
// EVERY card gets at least its `minW` columns (the issue #73 fix: the old code
// split 12 cols across 8 cards → four w=1 cards below the minW=2 floor, which
// RGL/CSS crushed and the user couldn't recreate).
//
//   • Cards-per-row is capped at floor(cols / maxMinW) so a single row never packs
//     more cards than fit at ≥ minW each. 8 cards × minW=2 on 12 cols → 6 per row
//     → 6 + 2 (two rows).
//   • Each ROW is then filled edge to edge among ITS cards: a row of `rowCount`
//     cards gets baseW = floor(cols/rowCount) each, the first (cols % rowCount)
//     getting +1, so every row SUMS TO `cols` (no ragged gap) AND every card stays
//     ≥ minW (because rowCount ≤ maxPerRow ⇒ floor(cols/rowCount) ≥ minW). So the
//     short last row (2 cards) spreads to w=6 each rather than leaving 8 cols empty.
//   • Each tile is stamped with (and never dropped below) its widget's min.
// PURE.
function statBand(
  ids: string[],
  cols: number,
  mins?: WidgetMins,
  wideIds?: ReadonlySet<string>
): { items: Placement[]; nextY: number } {
  const n = ids.length;
  if (n === 0) return { items: [], nextY: 0 };
  // The widest min among the cards bounds how many fit in one row at ≥ minW each.
  const maxMinW = Math.max(1, ...ids.map((i) => minWOf(i, mins)));
  const perRow = Math.min(n, Math.max(1, Math.floor(cols / maxMinW)));
  const items: Placement[] = [];
  let y = 0;
  // Process one row (a slice of up to `perRow` cards) at a time, distributing the
  // full `cols` width across exactly that row's cards so it fills edge to edge.
  for (let start = 0; start < n; start += perRow) {
    const row = ids.slice(start, start + perRow);
    const rowCount = row.length;
    const baseW = Math.floor(cols / rowCount);
    const extra = cols % rowCount; // this many cards in the row get +1 col
    // WHICH cards get the extra column: by default the first `extra` (row order),
    // but when `wideIds` is supplied (the strip's wide-content cards: yoy / budget /
    // the rate cards) the extra goes to THOSE first, so the cards whose headline is
    // widest get the +1 col and don't truncate their number. Any leftover extra
    // (more `extra` than wide cards in this row) falls back to the first non-wide
    // cards in order, so the row still sums to exactly `cols`. PURE.
    const getsExtra = new Set<number>();
    if (wideIds && wideIds.size > 0) {
      const wideCols = row.map((i, c) => (wideIds.has(i) ? c : -1)).filter((c) => c >= 0);
      for (const c of wideCols) {
        if (getsExtra.size >= extra) break;
        getsExtra.add(c);
      }
      for (let c = 0; c < rowCount && getsExtra.size < extra; c++) {
        if (!getsExtra.has(c)) getsExtra.add(c);
      }
    } else {
      for (let c = 0; c < extra; c++) getsExtra.add(c);
    }
    let x = 0;
    row.forEach((i, col) => {
      const w = baseW + (getsExtra.has(col) ? 1 : 0);
      items.push(withMins({ i, x, y, w, h: STAT_ROWS }, mins));
      x += w;
    });
    y += STAT_ROWS;
  }
  return { items, nextY: y };
}

// (RETIRED, CHANGE 1) `WIDE_STAT_TYPES` used to hand the strip's leftover `+1`
// columns to the widest-content cards, producing the mixed 4×w=2 + 4×w=1 strip the
// operator found "unbalanced". The even-strip iteration drops that distribution: the
// strip is now a FINE 24-col grid where 24 / 8 divides evenly, so every card gets
// the SAME width (no remainder to hand out). The set is now EMPTY but is still
// threaded through `generateLg`'s (toggle-off) stat band: it's passed to `statBand`
// (the lg-cockpit band used only when the strip is toggled OFF), where an empty set
// means no card is singled out for extra width — every card gets an even fill.
export const WIDE_STAT_TYPES: ReadonlySet<string> = new Set<string>();

// Lay a list of ids as an EVENLY-spaced single band that fills `cols` exactly: each
// card gets floor(cols / n) columns, ALL EQUAL, and any remainder (cols % n) is left
// as a small trailing gap rather than handed to a subset (which would make some
// cards wider — the "unbalanced" look CHANGE 1 fixes). When `cols` is divisible by
// `n` (the default 24/8 strip) there is NO remainder, so the row fills edge to edge
// with every card identical. Cards are clamped UP to the widest minW (so none falls
// below its floor) — if that forces unequal totals the band still keeps every card
// the same width (the common, divisible case stays perfectly even). Each tile is
// stamped with its registry min. PURE.
function evenBand(
  ids: string[],
  cols: number,
  mins?: WidgetMins
): { items: Placement[]; nextY: number } {
  const n = ids.length;
  if (n === 0) return { items: [], nextY: 0 };
  // The widest min bounds the smallest equal width we may use (no card below minW).
  const maxMinW = Math.max(1, ...ids.map((i) => minWOf(i, mins)));
  // The largest EQUAL width that fits all n cards in one row at ≥ minW each. If the
  // cards don't all fit one even row at the floor (n*maxMinW > cols), fall back to
  // the floor width (cards may then exceed `cols` slightly — RGL wraps them, the
  // documented "fewest even rows" fallback), but EVERY card stays the same width.
  const fitW = Math.floor(cols / n);
  const cellW = Math.max(maxMinW, fitW);
  const items: Placement[] = ids.map((i, idx) =>
    withMins({ i, x: idx * cellW, y: 0, w: cellW, h: STAT_ROWS }, mins)
  );
  return { items, nextY: STAT_ROWS };
}

// Generate the PINNED STRIP's own placements (issue #73; CHANGE 1 — even strip).
// The strip is an independent 24-col RGL grid of the stat cards, pinned above every
// page. Its default is a SINGLE row of EQUAL-WIDTH cards (evenBand): 8 cards on the
// 24-col band → 3 cols each, all identical, summing to 24 edge to edge — the
// operator's "evenly spaced" ask (replacing the old mixed w=1/w=2 distribution).
// Each card carries the registry's content-fit min bounds so it can't be dragged (or
// DEFAULTED) below its floor. The min lookup is passed in by the component (this
// module stays pure + registry-free). PURE — unit-tested.
export function generateStripPlacements(statIds: string[], mins?: WidgetMins): Placement[] {
  return evenBand(statIds, STRIP_COLS, mins).items;
}

// Generate the lg (12-col) cockpit: stat band on top, then a 2×2 chart GRID
// (half-width charts, two per row), with the bills panel below the charts. This
// is the no-scroll PAGINATED fit arrangement.
//
// 2×2 DENSITY (issue #73 iteration, operator decision): the old layout put
// charts in an 8-col left block two-up (w=4) alongside a 4-col bills rail, which
// made each chart only 1/3-width and — at the pinned-strip per-page budget of
// two chart rows — spread the 7 charts across ~5 sparse pages. The operator wants
// the old cockpit density back: ~4 charts per page in a true 2×2 (like a phone
// home screen, two columns × two rows of chart tiles). So charts now span HALF
// the grid (w=6 of 12) two-up at x=0 / x=6, and a page-row budget of two chart
// rows (PINNED_PAGE_ROWS = 2*CHART_ROWS) lands exactly four charts on a page. The
// 7 charts therefore paginate to ~2 pages instead of ~5.
//
// The bills panel can no longer be a right rail (the charts use the full width),
// so it sits as a full-width tile BELOW the charts; at the pinned per-page budget
// it falls onto its own page band (clampToPages keeps it whole), staying readable
// with its own internal scroll. Below the fit breakpoint (md/sm/xs) the page
// scrolls, so the panel just stacks under the charts as before.
function generateLg(input: DefaultLayoutInput): Placement[] {
  const cols = COLS.lg;
  const mins = input.mins;
  const out: Placement[] = [];

  // Stat band: reproduce today's full-width 8-up row, but cards-per-row capped at
  // floor(cols / minW) so EVERY card gets at least its minW columns (issue #73
  // fix). Each card gets floor(cols/perRow), the first (cols % perRow) get +1, so
  // a row's widths SUM TO `cols` (fills edge to edge); surplus cards wrap to a
  // second STAT_ROWS-tall row. 8 cards × minW=2 on 12 cols → 6 per row → 6 + 2.
  const stat = statBand(input.statIds, cols, mins, WIDE_STAT_TYPES);
  out.push(...stat.items);
  const afterStats = stat.nextY;

  // Charts: a full-width 2×2 grid — each chart is HALF the grid (6 of 12 cols),
  // two per row at x=0 / x=6, so two chart rows = four charts fill one page band
  // (PINNED_PAGE_ROWS). withMins stamps the registry's per-widget min (default
  // minW=3 / minH=2 here when no lookup is supplied) and lifts the size to it.
  const chartW = cols / 2; // 6 of 12 — half width, two-up
  input.chartIds.forEach((i, idx) => {
    out.push(
      withMins(
        {
          i,
          x: (idx % 2) * chartW,
          y: afterStats + Math.floor(idx / 2) * CHART_ROWS,
          w: chartW,
          h: CHART_ROWS,
          minW: 3,
          minH: 2,
        },
        mins
      )
    );
  });
  // How many chart rows the 2-up block occupies (≥ one so the panel still lands
  // below charts even with 0–2 charts). The bills panel goes on the row AFTER the
  // last chart row.
  const chartRowCount = Math.max(1, Math.ceil(input.chartIds.length / 2));
  const afterCharts = afterStats + chartRowCount * CHART_ROWS;

  // Bills panel: a full-width (12-col) tile below the charts, one page-band tall
  // (PINNED_PAGE_ROWS) so it occupies a clean page of its own under the pinned
  // strip — it scrolls internally, so a full page of bills reads well. At the
  // unpinned budget (DEFAULT_FIT_ROWS) it still fits within a band; clampToPages
  // re-bands it whole if a partly-filled chart band would otherwise straddle.
  input.panelIds.forEach((i) => {
    out.push(withMins({ i, x: 0, y: afterCharts, w: cols, h: PINNED_PAGE_ROWS, minW: 3, minH: 2 }, mins));
  });
  return out;
}

// Generate a SCROLLING breakpoint (md / sm): stat band N-up, charts two-up,
// panels full-width below. The page scrolls so heights need not sum to a
// viewport — we just stack the bands.
function generateScrolling(input: DefaultLayoutInput, cols: number, statW: number, chartW: number): Placement[] {
  const mins = input.mins;
  const out: Placement[] = [];
  // The stat band wraps so no card falls below its minW (issue #73 fix); `band`
  // caps cards-per-row at floor(cols / maxMinW) and stamps each tile's min.
  const stat = band(input.statIds, cols, statW, STAT_ROWS, 0, mins);
  out.push(...stat.items);

  let y = stat.nextY;
  // Two-up charts, each at least its registry minW (a chart whose half-width would
  // be below minW is widened by withMins, and the chart can't be resized below it).
  const effChartW = Math.min(cols, Math.max(chartW, ...input.chartIds.map((i) => minWOf(i, mins)), 1));
  const chartsPerRow = Math.max(1, Math.floor(cols / effChartW));
  input.chartIds.forEach((i, idx) => {
    out.push(
      withMins(
        {
          i,
          x: (idx % chartsPerRow) * effChartW,
          y: y + Math.floor(idx / chartsPerRow) * CHART_ROWS,
          w: effChartW,
          h: CHART_ROWS,
          minW: 2,
          minH: 2,
        },
        mins
      )
    );
  });
  y += Math.ceil(Math.max(input.chartIds.length, 1) / chartsPerRow) * CHART_ROWS;

  // Panels full-width below the charts.
  input.panelIds.forEach((i) => {
    out.push(withMins({ i, x: 0, y, w: cols, h: CHART_ROWS + 1, minW: 1, minH: 2 }, mins));
    y += CHART_ROWS + 1;
  });
  return out;
}

// Generate the xs (mobile) SINGLE-COLUMN stack: every widget full-width (w=1 of
// 1 col) in order stats → charts → panels, so mobile collapses to one column and
// scrolls (acceptance #3). Stat cards stay short; charts/panels are taller.
function generateXs(input: DefaultLayoutInput): Placement[] {
  const mins = input.mins;
  const out: Placement[] = [];
  let y = 0;
  // At xs the grid is ONE column, so every tile is full-width (w=1) and its minW
  // floor is 1 regardless of the registry's wider minW (a 2-/3-col min is
  // meaningless in a 1-col grid and would make RGL reject the placement). We still
  // honour the per-widget minH (clamped to the tile's own height) so a short tile
  // can't be dragged below its content. PURE.
  const push = (ids: string[], h: number) => {
    for (const i of ids) {
      const minH = Math.min(h, minHOf(i, mins));
      out.push({ i, x: 0, y, w: 1, h, minW: 1, minH });
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
  // `input.mins` (the registry min lookup, supplied by the caller) flows into every
  // breakpoint generator so NO emitted default placement is below its widget's
  // minW/minH — the issue #73 root-cause fix. Omitting mins keeps the legacy
  // geometry (no min stamp), which the pure-geometry tests rely on.
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
//
// SELF-HEAL (issue #73): a layout PERSISTED by the buggy generator can carry a
// sub-min `w`/`h` (the crushed stat cards). We repair each kept placement against
// the freshly-generated default's min for that widget — clamping `w`/`h` UP to the
// default's minW/minH and stamping those mins — so an existing dev/staging layout
// on the crushed default heals on the next merge without a factory reset. This is
// SAFE: it only ever GROWS a tile to a floor RGL would itself enforce on the first
// resize (it never shrinks a user's deliberate larger size, never moves x/y), and
// it's a no-op once the layout already satisfies the mins (idempotent). When the
// default carries no min (a registry-free caller), nothing is clamped.
function mergeOneBreakpoint(saved: Placement[], def: Placement[]): Placement[] {
  const defByI = new Map(def.map((p) => [p.i, p]));
  const kept = saved.filter((p) => defByI.has(p.i)).map((p) => healMins(p, defByI.get(p.i)!));
  const have = new Set(kept.map((p) => p.i));
  const appended = def.filter((p) => !have.has(p.i));
  return [...kept, ...appended];
}

// Clamp a saved placement up to the default's min bounds (and stamp those mins),
// leaving a placement that already meets them untouched. Only grows; never shrinks
// or moves. PURE.
function healMins(saved: Placement, def: Placement): Placement {
  let out = saved;
  if (typeof def.minW === 'number' && (out.minW !== def.minW || out.w < def.minW)) {
    out = { ...out, minW: def.minW, w: Math.max(out.w, def.minW) };
  }
  if (typeof def.minH === 'number' && (out.minH !== def.minH || out.h < def.minH)) {
    out = { ...out, minH: def.minH, h: Math.max(out.h, def.minH) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structural equality — the Customize-mode persist guard (issue #73 fix).
// ---------------------------------------------------------------------------
//
// RGL fires `onLayoutChange` for NON-user reasons too (mount, breakpoint switch,
// vertical compaction, and — critically — any prop-driven `layouts` change we
// feed it). In Customize mode the component persists from that handler, which
// updates state, which re-feeds RGL, which fires `onLayoutChange` again: a
// feedback loop that only terminates if the fed-back layout equals what we just
// persisted. The transform pipeline (merge → rebase → clamp → sanitize) is NOT
// a guaranteed fixed point, so the loop never converged → React #185 ("maximum
// update depth exceeded"). The robust break (how RGL apps normally persist):
// only `onPlacementsChange` when the new layout STRUCTURALLY DIFFERS from what's
// already persisted — a no-op change can't trigger another persist→render cycle.
//
// We compare the placement GEOMETRY only (i/x/y/w/h, plus minW/minH when set),
// order-independent per breakpoint (keyed by `i`), so a re-emit that merely
// reorders the array or restamps RGL's transient `moved`/`static` fields reads
// as equal. PURE — hand-calc unit-tested.

// Canonicalize one placement to just its serializable, order-stable geometry, so
// two placements with the same box compare equal regardless of extra RGL stamps
// or key order. minW/minH are only included when present (mirrors `sanitize`).
function canonPlacement(p: Placement): string {
  const min = `${p.minW ?? ''},${p.minH ?? ''}`;
  return `${p.i}:${p.x},${p.y},${p.w},${p.h}:${min}`;
}

// Are two breakpoint placement arrays the same SET of boxes (order-independent)?
// Keyed by widget id so a re-emit in a different array order still matches.
function bpEqual(a: Placement[], b: Placement[]): boolean {
  if (a.length !== b.length) return false;
  const map = new Map(a.map((p) => [p.i, canonPlacement(p)]));
  for (const p of b) {
    if (map.get(p.i) !== canonPlacement(p)) return false;
  }
  return true;
}

// Do two Placements blobs describe the SAME layout across every breakpoint? Used
// to bail out of the Customize-mode persist when RGL re-emits a layout identical
// to the one already in state (the infinite-render-loop fix, issue #73). A
// breakpoint present-but-empty on one side and absent on the other counts as
// equal (both render nothing there). PURE — hand-calc unit-tested.
export function placementsEqual(a: Placements, b: Placements): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<Breakpoint>;
  for (const bp of keys) {
    if (!bpEqual(a[bp] ?? [], b[bp] ?? [])) return false;
  }
  return true;
}

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
