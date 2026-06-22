// Layout types + default-placement generators (split out of the former
// monolithic lib/layoutEngine.ts, issue #157). This is the math/placement half of
// the react-grid-layout (RGL) work, kept here — with NO React / RGL / DOM
// dependency — so it's hand-calc unit-tested in isolation, the same discipline
// cockpit.ts / dashboardLayout.ts / series.ts follow. The component (WidgetLayout)
// wires RGL + the ResizeObserver to these functions; the load-bearing arithmetic
// and the default-placement generation live HERE, not buried in the component.
//
// WHAT THIS OWNS (the Phase-E concrete types Phase D reserved as an opaque
// passthrough, RFC §3.4 `DashboardLayout.layouts`):
//   • `Breakpoint` / `Placement` — the serializable per-breakpoint widget
//     placements RGL consumes and we persist.
//   • `generateDefaultPlacements(...)` — reproduces TODAY's dashboard arrangement
//     (stat band on top, charts in the main area, bills rail on the right at lg)
//     from the Phase-D order/visibility, so an existing user with no saved
//     `layouts` opens to exactly today's view (acceptance #1).

// The responsive breakpoints, widest → narrowest, mirroring RGL's keys. We use
// four (RFC §3.3: "lg ≥1280 / md / sm / xs"):
//   • lg  ≥1232 — the NO-SCROLL fit cockpit (the `xl` band the old layout pinned
//                 to the viewport). 12 columns.
//   • md  ≥ 996 — wide-but-not-fit; page scrolls (today's 768–1280 two-up band's
//                 upper half).
//   • sm  ≥ 768 — the old two-column band's lower half; page scrolls.
//   • xs  < 768 — MOBILE: TWO columns, page scrolls. Stat cards pair 2-up; charts
//                 and panels span full width. (issue #110 — was 1 col/1-up)
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
// fewer columns. xs is TWO columns (issue #110): stat cards pair up 2-up on
// mobile (~195px each on a 390px phone) while charts/panels stay full-width
// (w=2), so the stat band is more scannable without clipping. RGL maps a
// placement's `x`/`w` against these.
export const COLS: Record<Breakpoint, number> = { lg: 12, md: 8, sm: 6, xs: 2 };

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
// the layout lib pure: the registry-derived mins are passed in, never imported.
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
//   • xs (2 col): stat cards 2-up (w=1 each), charts + panels full-width (w=2),
//     order stats → charts → panels, mobile scrolls (issue #110).
//
// Heights are in grid rows; the component's runtime rowHeight (computePageFit
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

// Generate the xs (mobile) layout: stat cards 2-up (half-width each), charts and
// panels full-width, in order stats → charts → panels, page scrolls (issue #110).
//
// STAT CARDS 2-UP (issue #110): xs is a 2-col grid (COLS.xs = 2), so the stat band
// pairs cards side by side — stat k at x = k%2, w=1, y = base + floor(k/2)*STAT_ROWS.
// At ~195px each on a 390px phone the compact title+headline still reads clearly, and
// the stat band takes half the vertical space it did at 1-up. minW is 1 regardless of
// the registry's wider mins (a chart's 3-col min is meaningless on a 2-col grid).
//
// CHARTS AND PANELS FULL-WIDTH: each spans the whole 2-col grid (x=0, w=COLS.xs),
// stacked one per row after the stat band, monotonically increasing y. The same
// minW=1 floor (registry-wide mins don't apply on xs). Per-widget minH is honoured
// (clamped to the tile's own height) so a tile can't be dragged below its content.
// PURE.
function generateXs(input: DefaultLayoutInput): Placement[] {
  const mins = input.mins;
  const cols = COLS.xs; // 2
  const out: Placement[] = [];

  // Stat cards: 2-up — pair at (x=0,y) and (x=1,y), each half the grid wide.
  input.statIds.forEach((i, k) => {
    const minH = Math.min(STAT_ROWS, minHOf(i, mins));
    out.push({ i, x: k % 2, y: Math.floor(k / 2) * STAT_ROWS, w: 1, h: STAT_ROWS, minW: 1, minH });
  });

  // Running y after the stat block; ceil handles an odd stat count.
  let y = Math.ceil(input.statIds.length / 2) * STAT_ROWS;

  // Charts and panels: full-width (span both columns), stacked one per row.
  for (const i of [...input.chartIds, ...input.panelIds]) {
    const minH = Math.min(CHART_ROWS, minHOf(i, mins));
    out.push({ i, x: 0, y, w: cols, h: CHART_ROWS, minW: 1, minH });
    y += CHART_ROWS;
  }

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
