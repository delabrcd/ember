'use client';

// The react-grid-layout host (Phase E of the UI re-architecture, issue #73; RFC
// §3.3 + Decision 2), with the PER-PAGE BOUNDED no-scroll fit from the operator's
// root-cause architecture pass. This is the component half of the layout engine:
// it takes the placed widgets, renders them through the registry inside RGL's
// Responsive grid, and at the fit breakpoint PAGINATES them like a phone home
// screen — NEVER scrolling. All the load-bearing MATH (the page partition, the
// fill-the-page rowHeight derivation, the tile-can't-straddle-a-page repair, the
// per-page rebase) lives in lib/layoutEngine.ts (pure, unit-tested); this
// component only wires RGL + a ResizeObserver to those functions.
//
// THE FIT MODEL (issue #73 root-cause fix — each page is its OWN bounded grid):
//   • The available band is measured ONCE: availH = viewportH − gridTop −
//     pagerH (− the pinned strip's height when shown). gridTop is the grid
//     container's real getBoundingClientRect().top, which folds chrome + page
//     padding + the gap into one DPI-independent CSS-pixel number. pagerH is the
//     pager element's OWN measured height (issue #73 polish — see below), not a
//     guessed constant, so the pager is always reserved exactly and stays fully
//     visible inside the pinned (overflow-hidden) viewport.
//   • computePageFit derives (R, rowHeight) from that band: R is the design
//     rows-per-page (a 2×2 of charts → 2*CHART_ROWS), reduced only if the band is
//     too short to give R rows a readable height; rowHeight = (availH −
//     (R+1)*margin)/R so EXACTLY R rows fill availH → no scroll.
//   • VIEW MODE renders ALL pages as full-width SLIDES in a horizontal track
//     (translateX(−activePage*100%) with a CSS transition — a phone-home-screen
//     SIDE-SCROLL, issue #73 polish #2), inside an overflow-hidden viewport. Each
//     slide is STILL its own viewport-HEIGHT bounded grid: that page's placements
//     REBASED to local y=0, in an RGL of height exactly availH with maxRows = R.
//     There is NO clip window and NO vertical translate: a tile cannot be sheared
//     at a page boundary because each slide IS its own grid that exactly fits. The
//     pager (prev/next + dots) drives activePage → the track slides horizontally.
//   • CUSTOMIZE MODE renders the FULL canvas (all pages stacked) with vertical
//     scroll + page-boundary guides, so every widget on every page is reachable
//     and a tile can be dragged down past a boundary onto a later page; on save
//     each tile's page comes from its `y` (clampToPages keeps it straddle-free).
//   • PINNED STAT STRIP (default on): the stat cards render in their OWN editable
//     RGL grid pinned above the paged slide-track (always visible, not paged; the
//     strip is identical on every page). Its placements ride the same layout blob
//     under a reserved key (no schema change) and it's drag/resize-arrangeable in
//     Customize mode just like the page grid. Toggle it off and the stats become
//     ordinary tiles that page with the rest.
//   • Below the fit breakpoint (mobile / md): UNCHANGED — a fixed rowHeight, the
//     page scrolls normally, NO pager.

import { forwardRef, useEffect, useLayoutEffect, useMemo, useRef, useState, type TouchEvent as ReactTouchEvent } from 'react';
import { Responsive, WidthProvider, type Layout, type Layouts } from 'react-grid-layout';
import {
  BREAKPOINTS,
  CHART_ROWS,
  COLS,
  DEFAULT_FIT_ROWS,
  PINNED_PAGE_ROWS,
  FIT_BREAKPOINT,
  STRIP_COLS,
  STRIP_KEY,
  computePageFit,
  findFreeSlot,
  generateDefaultPlacements,
  generateStripPlacements,
  mergePlacements,
  pageCount as computePageCount,
  paginatePlacements,
  placementsEqual,
  readStrip,
  rebaseToLocal,
  withStrip,
  type Breakpoint,
  type Placement,
  type Placements,
} from '@/lib/layoutEngine';
import { clampPage } from '@/lib/cockpit';
import { getWidget, widgetMins, type WidgetHost } from '@/lib/widgets/registry';

// WidthProvider measures the container width for us so the grid is responsive
// without a hardcoded width (the standard RGL setup). Memoized at module scope so
// it isn't re-created each render (re-creating it remounts the whole grid).
const ResponsiveGrid = WidthProvider(Responsive);

// RGL margins (px). One value reused for x and y; the fit math accounts for
// `rows + 1` of these vertically so the page height matches RGL's real spacing.
// We also pass it as containerPadding so the outer gap equals the inter-row gap
// (the assumption the fit formula folds in).
const MARGIN = 8;

// Fallback vertical room for the pager (prev/next + dots) used ONLY on the very
// first paint, before the pager element has been measured. At runtime the pager's
// REAL height is measured (pagerH state, via the same ResizeObserver) and used in
// availH — issue #73 polish #1: the pager is fixed chrome INSIDE the pinned
// viewport, so its exact height must be reserved or it gets pushed below the
// overflow-hidden fold and the arrows are clipped/unreachable after a resize. This
// constant is just the bootstrap guess until the first measure lands.
const PAGER_FALLBACK_H = 44;

// The flex gap (px) between the strip / paged grid / pager in the layout column
// (Tailwind `gap-2`). Folded into the reserved chrome alongside the measured pager
// height so the slide-track + pager together fit the band with the pager fully
// visible (its bottom a hair above the viewport edge, never clipped).
const COLUMN_GAP = 8;

// The bottom gutter (px) reserved below the pager in the pinned fit view (issue #73
// polish #2 — operator: "no padding at the bottom"). gridTop folds in everything
// ABOVE the grid (chrome + top page padding), but nothing accounted for the page's
// BOTTOM padding, so the pager landed flush against the overflow-hidden viewport
// edge. We subtract this from availH so the slide-track + pager are sized to stop
// this many px above the viewport bottom → a visible gap below the arrows, with NO
// new scroll and the pager never clipped. It MATCHES the shell's `xl:py-3` (12px)
// so the bottom gutter equals the top one. Only reserved at the fit breakpoint
// (below it the page scrolls and the shell's own padding already applies).
const BOTTOM_PAD = 12;

// The fixed, readable rowHeight used BELOW the fit breakpoint (the scrolling
// breakpoints) and on the very first paint at fit before the band is measured. At
// fit the rowHeight is DERIVED (computePageFit) so R rows exactly fill the band —
// never this constant — so there's no nominal-row guessing in the fit math.
const FALLBACK_ROW_HEIGHT = 40;

// The pinned strip's row height (px). The strip is NOT viewport-filling — it's
// sized to its cards' content (its height is measured and SUBTRACTED from availH),
// so it uses a fixed readable row, NOT the fit-derived one. A compact simple card
// is STAT_ROWS=2 rows → 2*30 + 8 = 68px (covers its 66px essential border-box with a
// hair of slack); the budget card reserves a progress bar (minH=3) → 3*30 + 16 =
// 106px, which drives the single-row strip band height. Mirrors REF_ROW_HEIGHT in
// registry.tsx, where the same row height derives each card's grid `minH`.
const STRIP_ROW_HEIGHT = 30;

export interface WidgetLayoutProps {
  // The widget ids to place, by category, IN ORDER — the host computes these
  // from the Phase-D layout (visible charts in saved order), the visible stat
  // specs, and the bills panel. Drives both the default generator and the
  // palette's "what's currently placed vs available".
  statIds: string[];
  chartIds: string[];
  panelIds: string[];
  // Saved per-breakpoint placements (from the server layout's `layouts` blob), or
  // undefined when the account has none yet → we generate + persist the default.
  savedPlacements: Placements | undefined;
  // Persist a new placements blob (debounced PUT in useDashboardLayout).
  onPlacementsChange: (p: Placements) => void;
  // True in the fit layout (always on now — see Dashboard's `const fit = true`).
  // Only at the lg breakpoint AND in fit do we paginate + pin the page to the
  // viewport; otherwise the page scrolls (today's behaviour).
  fit: boolean;
  // Customize mode on/off — drag/resize + remove affordances + the palette.
  customizing: boolean;
  // PINNED STAT STRIP (issue #73 iteration). When true the stat widgets render in
  // a fixed band above the paged grid (always visible, not paged); when false
  // they page as ordinary tiles. From the server layout blob.
  pinnedStatStrip: boolean;
  // The registry host every widget render reads (data resolvers, configs, etc.).
  host: WidgetHost;
  // Remove a widget from the placed set (the per-widget × affordance in a cell).
  onRemoveWidget: (type: string) => void;
  // Toggle a widget's pinned-to-top-bar state (issue #73 polish #4). Pinning moves
  // it from the active page into the __strip grid; unpinning moves it back to a free
  // page slot. Optional so non-fit callers can omit the affordance. The host
  // (Dashboard) owns the cross-grid placement move + persistence.
  onTogglePin?: (type: string) => void;
  // The SPACER instance ids currently placed (CHANGE 2), derived by the host from
  // the saved blob (the page grid + strip). Spacers are user-added and NOT produced
  // by the default generator, so the host hands them in explicitly: they're folded
  // into the placed universe (so they render) and into the merge defaults (so the
  // saved-blob repair preserves them instead of dropping them as "unknown").
  spacerIds?: string[];
}

// Map RGL's 5-key breakpoint object down to our 4 (we don't use xxs). RGL still
// wants all configured breakpoints present in `cols`/`breakpoints`; we simply
// don't define xxs, so RGL never selects it.
const RGL_BREAKPOINTS = BREAKPOINTS as unknown as { [k: string]: number };
const RGL_COLS = COLS as unknown as { [k: string]: number };

export function WidgetLayout(props: WidgetLayoutProps) {
  const {
    statIds,
    chartIds,
    panelIds,
    savedPlacements,
    onPlacementsChange,
    fit,
    customizing,
    pinnedStatStrip,
    host,
  } = props;
  const spacerIds = useMemo(() => props.spacerIds ?? [], [props.spacerIds]);

  // The default placements that reproduce today's dashboard for the CURRENT
  // visible set. Recomputed when the set changes (a chart toggled, a card
  // appeared) so a newly-shown widget always has a default slot to fall into.
  // `mins` (the registry's per-widget minW/minH) is threaded into the PURE
  // generator so no default placement falls below a widget's floor — the issue #73
  // fix (the crushed stat strip). It also lets mergePlacements self-heal a
  // previously-persisted crushed default up to the min.
  const defaults = useMemo(() => {
    const base = generateDefaultPlacements({
      statIds,
      chartIds,
      panelIds,
      mins: widgetMins([...statIds, ...chartIds, ...panelIds]),
    });
    if (spacerIds.length === 0) return base;
    // SPACERS (CHANGE 2) aren't produced by the generator, so fold each placed
    // spacer's SAVED geometry (or, missing, a free-slot fallback at its registry
    // default size) into every breakpoint's defaults — this is what lets
    // mergePlacements PRESERVE spacers (it keeps only ids present in the default;
    // without this a spacer would be dropped on the next repair). The saved geometry
    // is authoritative when present so a moved/resized spacer round-trips.
    const out: Placements = { ...base };
    const { defaultSize } = getWidget(spacerIds[0]); // all spacers share the prototype size
    for (const key of Object.keys(COLS) as Breakpoint[]) {
      const arr = [...(base[key] ?? [])];
      const cols = COLS[key];
      const savedArr = savedPlacements?.[key] ?? [];
      for (const id of spacerIds) {
        const saved = savedArr.find((p) => p.i === id);
        if (saved) {
          arr.push({ ...saved, minW: defaultSize.minW, minH: defaultSize.minH });
        } else {
          const slot = findFreeSlot(arr, defaultSize, cols);
          arr.push({
            i: id,
            x: slot.x,
            y: slot.y,
            w: Math.min(defaultSize.w, cols),
            h: defaultSize.h,
            minW: defaultSize.minW,
            minH: defaultSize.minH,
          });
        }
      }
      out[key] = arr;
    }
    return out;
  }, [statIds, chartIds, panelIds, spacerIds, savedPlacements]);

  // The effective per-breakpoint layouts RGL renders: the saved placements
  // repaired against the fresh defaults (drop removed widgets, append newly-added
  // ones at their default slot), or the pure defaults when nothing is saved.
  const layouts: Placements = useMemo(
    () => mergePlacements(savedPlacements ?? {}, defaults),
    [savedPlacements, defaults]
  );

  // FIRST-LOAD PERSIST (acceptance #1 + #5): an existing user has a Phase-D
  // layout with NO `layouts` yet → generate the default and persist it ONCE so
  // they open to today's dashboard AND can then customize. Guarded by a ref so we
  // persist exactly once per mount-with-no-saved-placements.
  const placedIds = useMemo(
    () => [...statIds, ...chartIds, ...panelIds, ...spacerIds],
    [statIds, chartIds, panelIds, spacerIds]
  );
  const persistedDefault = useRef(false);
  useEffect(() => {
    if (!savedPlacements && !persistedDefault.current && placedIds.length > 0) {
      persistedDefault.current = true;
      onPlacementsChange(defaults);
    }
    if (savedPlacements) persistedDefault.current = true;
  }, [savedPlacements, defaults, onPlacementsChange, placedIds.length]);

  // ---- Active breakpoint ----
  // Default to the FIT breakpoint on the server/first paint (lg) so SSR matches
  // the common desktop case and there's no fit→scroll flash.
  //
  // We do NOT rely on RGL's onBreakpointChange ALONE (issue #73 polish #1): RGL's
  // WidthProvider measures the grid CONTAINER width, which can LAG a real drag-
  // resize by a frame (and, when the active page unmounts/remounts on a slide, the
  // container width it reports can be stale) — so a fast mobile→desktop round-trip
  // could leave `bp` stuck on the wrong breakpoint, the fit math off, and the pager
  // pushed below the fold. We ALSO sync the active breakpoint from a window-level
  // matchMedia/resize listener keyed on window.innerWidth, which can't lag, so a
  // round-trip always settles on the correct breakpoint and re-fits. The two
  // sources agree at rest; the window listener is the authority during a resize.
  const [bp, setBp] = useState<Breakpoint>(FIT_BREAKPOINT);
  useEffect(() => {
    // Derive the active breakpoint from the VIEWPORT width the same way RGL's
    // WidthProvider would from the container, but directly off window.innerWidth so
    // it tracks a drag-resize with no measurement lag. The thresholds mirror
    // BREAKPOINTS; we pick the widest whose min ≤ the current width.
    const pick = (): Breakpoint => {
      const w = window.innerWidth;
      const order: Breakpoint[] = ['lg', 'md', 'sm', 'xs'];
      for (const k of order) if (w >= BREAKPOINTS[k]) return k;
      return 'xs';
    };
    const sync = () => {
      const next = pick();
      setBp((prev) => (prev === next ? prev : next));
    };
    sync();
    window.addEventListener('resize', sync);
    return () => window.removeEventListener('resize', sync);
  }, []);

  // ---- Runtime chrome + viewport measurement (the no-scroll fit) ----
  // We measure the GRID CONTAINER'S TOP (its viewport-relative y, in CSS pixels)
  // AND, when the stat strip is pinned, the pinned strip's own height, so the
  // paged area's available band is computed — never a hand-tuned constant.
  //
  // WHY gridTop, NOT chromeHeight (the header-cutoff fix, CHANGE 1): the previous
  // math used `available = viewportH − chromeHeight − …`, but the grid does NOT
  // begin at `chromeHeight` from the top of the viewport — it begins below the
  // PAGE PADDING (the shell's `py-3`) AND the flex `gap` between the chrome and
  // the grid. So `viewportH − chromeHeight` over-counted the band by exactly
  // (pageTopPadding + gap) ≈ 20px: the fit math sized the page that much too tall,
  // so at the no-scroll-pinned breakpoint the page's content ran 20px past the
  // viewport and the bottom row (or, once a banner pushed the chrome down, the
  // FIRST row) was clipped behind/under the fixed chrome. Measuring the
  // container's real top via getBoundingClientRect().top folds the chrome height,
  // the page padding AND the gap into one number, so `available = viewportH −
  // gridTop − …` is exact regardless of how the chrome/padding/gap compose. It's a
  // CSS-pixel quantity (getBoundingClientRect/innerHeight are DPI-independent —
  // devicePixelRatio never enters the math), so it's robust across resolutions
  // and DPIs (CHANGE 3). gridTop is read from the container itself (always present)
  // rather than the chrome element, so a missing/late chrome can't zero it out.
  const [viewportH, setViewportH] = useState(0);
  const [gridTop, setGridTop] = useState(0);
  const [stripH, setStripH] = useState(0);
  // The pager's OWN measured height (issue #73 polish #1). Reserved exactly in
  // availH so the pager — fixed chrome inside the pinned, overflow-hidden viewport
  // — is always FULLY visible: the slide-track is sized so grid + pager together
  // fit, the pager's bottom landing a hair above the viewport edge, never clipped.
  const [pagerH, setPagerH] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const pagerRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chrome = container.parentElement?.querySelector<HTMLElement>('[data-dashboard-chrome]') ?? null;

    // Measure into state, but only WRITE when a value actually changed — the
    // ResizeObserver fires on every layout pass (and our own re-renders resize the
    // grid, which the observer sees), so an unconditional setState would churn and
    // could feed a render→measure→render loop. The functional-update form compares
    // against the latest committed value and returns it unchanged on a no-op, so
    // React bails the re-render (the Customize-mode loop guard, kept intact).
    const measure = () => {
      // The container's TOP measured WITHOUT its own paged-grid height influencing
      // it: getBoundingClientRect().top is the distance from the viewport top to
      // the grid column's first pixel — i.e. everything above it (chrome + page
      // padding + gap). DPI-independent CSS pixels.
      const top = container.getBoundingClientRect().top;
      const sh = stripRef.current ? stripRef.current.getBoundingClientRect().height : 0;
      // The pager's real rendered height — measured, not guessed, so it's reserved
      // exactly and the arrows can't be cut off after a viewport round-trip.
      const ph = pagerRef.current ? pagerRef.current.getBoundingClientRect().height : 0;
      const vh = window.innerHeight;
      setViewportH((prev) => (prev === vh ? prev : vh));
      // Round to whole CSS pixels so sub-pixel jitter from fractional DPI scaling
      // (e.g. a 1.25× display reporting 127.5px) can't flip the value every frame
      // and re-trigger the fit recompute → a quiet, change-only update.
      setGridTop((prev) => (Math.abs(prev - top) < 0.5 ? prev : top));
      setStripH((prev) => (Math.abs(prev - sh) < 0.5 ? prev : sh));
      setPagerH((prev) => (Math.abs(prev - ph) < 0.5 ? prev : ph));
    };
    measure();

    // Observe the chrome (so a banner appearing/dismissing remeasures the band),
    // the pinned strip, AND the pager — so a wrapped/taller pager (or one that
    // appears once a layout grows past one page) is reserved correctly. The
    // container itself is NOT observed — its height is the fit OUTPUT, so observing
    // it would close a measure→resize→measure loop.
    const ro = new ResizeObserver(measure);
    if (chrome) ro.observe(chrome);
    if (stripRef.current) ro.observe(stripRef.current);
    if (pagerRef.current) ro.observe(pagerRef.current);
    // window.resize covers viewport-height changes (which a chrome ResizeObserver
    // alone would miss — the chrome's height needn't change when the window does)
    // AND DPI/zoom changes that reflow the layout (CHANGE 3: recompute on resize).
    // It ALSO re-fits after a breakpoint round-trip (issue #73 polish #1): a
    // mobile→desktop drag fires resize, which remeasures gridTop/strip/pager so
    // availH and the pager position are correct when we land back on the fit
    // breakpoint — the pager is never left below the fold.
    window.addEventListener('resize', measure);
    // A double-rAF re-measure after this effect re-runs catches the pager/strip
    // settling AFTER a breakpoint switch remounts them (the elements that mount on
    // the fit breakpoint aren't laid out yet on the synchronous pass), so the
    // mobile→desktop round-trip ends with a correct, pager-reserving availH.
    const raf1 = requestAnimationFrame(() => requestAnimationFrame(measure));
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
      cancelAnimationFrame(raf1);
    };
    // Re-run when the pinned strip / pager mounts/unmounts (refs change with the
    // breakpoint) so we observe the right elements and remeasure the band. `bp` is
    // in the deps so the breakpoint round-trip re-observes + re-measures.
  }, [pinnedStatStrip, statIds.length, bp]);

  // Only paginate (and pin the page) at the lg breakpoint in fit density.
  const fitActive = fit && bp === FIT_BREAKPOINT;

  // ---- The PINNED STRIP's own placements (issue #73 polish #4 — ANY widget) ----
  // The strip is its OWN editable RGL grid. Its placements ride the layout blob
  // under the reserved STRIP_KEY (no schema change). Generalized from stats-only to
  // ANY widget (chart/panel/stat) the user pins to the top bar:
  //   • MEMBERSHIP is the saved __strip set, NOT the stat category — a chart or the
  //     bills panel can live here too. We repair it against the currently-placed
  //     universe (drop a strip entry whose widget was removed/hidden) so a stale
  //     pin can't render a ghost tile.
  //   • MIGRATION / default: when NOTHING is saved under __strip yet, the default
  //     strip is today's full-width stat band (generateStripPlacements(statIds)) —
  //     so an existing user still opens to the stats-pinned dashboard (today's
  //     semantics) until they pin/unpin something, at which point __strip becomes
  //     the explicit authority.
  // Min bounds come from the registry (content-fit), filled here since the pure
  // generator emits only geometry. Recomputed when the placed set or saved strip
  // changes.
  const stripPlacements = useMemo<Placement[]>(() => {
    const saved = readStrip(savedPlacements);
    // The default (pre-customization) strip = today's stat band; once __strip is
    // explicitly saved, IT is the authority (an empty saved __strip means "nothing
    // pinned", NOT "fall back to stats").
    // The default strip is generated WITH the registry mins so the stat band wraps
    // to respect each card's minW (issue #73 fix: 8 cards × minW=2 → 6 per row +
    // 2, never the old four crushed w=1 cards) and carries its min floor.
    const source = saved ?? generateStripPlacements(statIds, widgetMins(statIds));
    // Repair against the placed universe: a pinned widget must still be a placed,
    // available widget (its page-grid counterpart was removed → drop the pin too).
    const known = new Set(placedIds);
    const kept = source.filter((p) => known.has(p.i));
    // Stamp each tile's content-fit min bounds from the registry so it can't be
    // dragged uselessly small, and lift a sub-min width UP to the floor so a
    // SAVED strip persisted by the buggy generator (a crushed w=1 stat) self-heals
    // instead of staying below the minW RGL enforces on resize.
    return kept.map((p) => {
      const { defaultSize } = getWidget(p.i);
      return {
        ...p,
        minW: defaultSize.minW,
        minH: defaultSize.minH,
        w: Math.max(p.w, defaultSize.minW),
        h: Math.max(p.h, defaultSize.minH),
      };
    });
  }, [statIds, placedIds, savedPlacements]);

  // The set of pinned widget ids (whatever currently lives in the strip). Drives
  // the grid/strip split AND the per-cell "pinned" highlight + pin/unpin affordance.
  const pinnedIds = useMemo(() => new Set(stripPlacements.map((p) => p.i)), [stripPlacements]);

  // The strip is SHOWN (pinned out of the paged area) when the toggle is on, we're
  // fit-active, AND at least one widget is pinned. Replaces the old stats-only
  // `pinStats` — the gate is now membership-driven, not category-driven.
  const pinActive = fitActive && pinnedStatStrip && pinnedIds.size > 0;

  // The ids that render in the PAGED grid: every placed id MINUS the pinned ones
  // (when the strip is shown). Below fit / strip off, every placed id is a tile.
  const gridIds = useMemo(
    () => (pinActive ? placedIds.filter((id) => !pinnedIds.has(id)) : placedIds),
    [pinActive, placedIds, pinnedIds]
  );

  // True when the stat BAND still lives on the page (i.e. not every stat is pinned).
  // It decides the per-page row budget: stats-on-page → a band + chart rows
  // (DEFAULT_FIT_ROWS, quantum 1); stats-pinned-out → pure chart rows
  // (PINNED_PAGE_ROWS, quantum CHART_ROWS). This generalizes the old "pinStats"
  // budget switch: pinning a CHART (stats still on the page) keeps the band budget;
  // pinning all stats drops to the chart-only budget exactly as before.
  const statsOnPage = useMemo(() => gridIds.some((id) => id.startsWith('stat:')), [gridIds]);

  // The lg placements actually fed to the grid: the merged set, minus the pinned
  // widgets. When the pinned set sat below row 0 (e.g. the stat band is pinned out,
  // leaving charts that the default generator placed at y=STAT_ROWS), the remaining
  // tiles still carry that row offset, so we REBASE them up to start at row 0 —
  // otherwise page 1 would waste the band the pinned widgets used to occupy. Below
  // the fit breakpoint RGL reads the per-breakpoint blob as-is.
  const gridLgPlacements = useMemo(() => {
    const lg = layouts[FIT_BREAKPOINT] ?? [];
    const keep = new Set(gridIds);
    const kept = lg.filter((p) => keep.has(p.i));
    if (!pinActive || kept.length === 0) return kept;
    const minY = Math.min(...kept.map((p) => p.y));
    return minY > 0 ? kept.map((p) => ({ ...p, y: p.y - minY })) : kept;
  }, [layouts, gridIds, pinActive]);

  // ---- The per-page bounded fit math (PURE computePageFit from layoutEngine) ----
  // availH = viewport − everything above the grid (gridTop folds in chrome + page
  // padding + the gap) − the pinned strip (when shown) − the MEASURED pager band.
  // Using gridTop (not a bare chrome height) is the header-cutoff fix: the grid is
  // sized to EXACTLY the space below its own top, so the first row sits clear of the
  // chrome and the last row stops at the viewport edge — no clip, no scroll.
  //
  // THE PAGER RESERVATION (issue #73 polish #1): we subtract the pager's REAL
  // measured height (pagerH) plus the flex gap above it, NOT a guessed constant —
  // so the slide-track is sized so grid + pager together fit the viewport with the
  // pager FULLY visible (its bottom a hair above the viewport edge). We ALWAYS
  // reserve the pager band when fit-active (even on a single page, where the pager
  // is hidden), exactly as the old constant did: this avoids a circular dependency
  // (availH → rowsPerPage → totalPages → "does a pager show?" → availH) and only
  // costs a single-page layout the pager's worth of height, which is the prior
  // behaviour. Until the first measure lands (pagerH===0) we use PAGER_FALLBACK_H.
  const pagerReserve = fitActive ? (pagerH > 0 ? pagerH : PAGER_FALLBACK_H) + COLUMN_GAP : 0;
  // Reserve the bottom gutter (issue #73 polish #2) alongside the pager so the
  // slide-track + pager stop BOTTOM_PAD px above the viewport edge — a visible gap
  // below the arrows, no new scroll. Only at the fit breakpoint (the page is pinned
  // there); below it the shell's own padding applies and the page scrolls.
  const bottomReserve = fitActive ? BOTTOM_PAD : 0;
  const availH = Math.max(
    0,
    viewportH - gridTop - (pinActive ? stripH + COLUMN_GAP : 0) - pagerReserve - bottomReserve
  );

  // The DESIGN per-page row budget: DEFAULT_FIT_ROWS when the stat band still pages
  // with the grid (a band + two chart rows), or PINNED_PAGE_ROWS (just the two
  // chart rows) when the band is pinned out — so a page of charts still fills the
  // viewport as a 2×2. Keyed on statsOnPage (not the old stats-only pin flag) so
  // pinning a CHART while stats stay on the page keeps the band budget; pinning all
  // stats drops to the chart-only budget. computePageFit honours this budget but
  // reduces it on a short viewport so the rows stay readable (it adapts, never
  // scrolls).
  const designRows = statsOnPage ? DEFAULT_FIT_ROWS : PINNED_PAGE_ROWS;

  // (R, rowHeight) for the active page: R rows EXACTLY fill availH at rowHeight, so
  // a page is viewport-tall with no scroll. Before the first measure (or below the
  // fit breakpoint) we use the design budget + the fixed fallback row. When the
  // stat band is pinned out the paged area is pure CHART rows, so we quantize R to
  // CHART_ROWS — a page holds a whole 2×2 / 1×2, never a partial chart row that
  // would straddle a boundary and leave a wasted empty band. With stats still on
  // the page it mixes a band with chart rows, so no quantum applies (default 1).
  const { rows: rowsPerPage, rowHeight } = useMemo(() => {
    if (!fitActive || viewportH === 0) return { rows: designRows, rowHeight: FALLBACK_ROW_HEIGHT };
    return computePageFit({ availH, designRows, marginY: MARGIN, rowQuantum: statsOnPage ? 1 : CHART_ROWS });
  }, [fitActive, viewportH, availH, designRows, statsOnPage]);

  // The page partition + count (only meaningful when fit-active). clampToPages (in
  // paginatePlacements) guarantees no tile straddles a boundary; view mode mounts
  // one page (rebased to local y=0), customize shows the whole (clamped) canvas.
  const pages = useMemo(
    () => (fitActive ? paginatePlacements(gridLgPlacements, rowsPerPage) : []),
    [fitActive, gridLgPlacements, rowsPerPage]
  );
  const totalPages = fitActive ? pages.length : 1;

  // Active page index, clamped so the pager can never select an out-of-range page
  // when the layout shrinks underneath it (the retired CockpitPager's discipline).
  const [activePage, setActivePage] = useState(0);
  const safePage = clampPage(activePage, totalPages);
  useEffect(() => {
    // Snap a now-out-of-range index back in (e.g. a removed widget collapsed a
    // page). Done in an effect so we don't setState during render.
    if (activePage !== safePage) setActivePage(safePage);
  }, [activePage, safePage]);

  // ---- Trackpad horizontal-scroll paging (issue #73 polish #3) ----
  // Operator: "allow the user to scroll left or right (say on their trackpad) to
  // swap to the next panel." We attach a NON-PASSIVE wheel listener to the slide
  // viewport so a HORIZONTAL gesture (deltaX dominant, OR shift+wheel — the common
  // mouse-wheel→horizontal convention) advances/retreats activePage, and we
  // preventDefault so the browser doesn't rubber-band / over-scroll the page. A
  // VERTICAL wheel (deltaY dominant) is left ALONE so it still scrolls an
  // internally-scrollable widget (the bills table) and the page below the fit
  // breakpoint. One gesture = one page change: we throttle on a time gate + require
  // the delta to clear a threshold, and arm/disarm on the gesture's momentum (we
  // ignore the long tail of inertial events until the wheel quiets down). Only
  // wired when fit-active with more than one page (otherwise there's nothing to
  // page); a ref lets the effect read the latest totalPages without re-binding.
  const slideViewportRef = useRef<HTMLDivElement | null>(null);
  const totalPagesRef = useRef(totalPages);
  totalPagesRef.current = totalPages;
  useEffect(() => {
    const el = slideViewportRef.current;
    if (!el || !fitActive || totalPages <= 1) return;
    // The minimum |deltaX| (px-ish; wheel units vary by device) for a step, and the
    // quiet-time after a step before another gesture can fire — together "one
    // gesture = one page". A trackpad fires a burst of small deltas; the time gate
    // collapses the burst into a single page change, and the threshold ignores
    // jitter from a mostly-vertical scroll that has a tiny horizontal component.
    const STEP_THRESHOLD = 30;
    const STEP_COOLDOWN_MS = 500;
    let lastStepAt = 0;
    const onWheel = (e: WheelEvent) => {
      // Horizontal intent: deltaX dominates, OR the user holds Shift (mouse-wheel
      // horizontal convention). A dominant deltaY is a vertical scroll → ignore it
      // entirely so internal widget scrolling still works.
      const dx = e.shiftKey && e.deltaX === 0 ? e.deltaY : e.deltaX;
      const horizontal = Math.abs(dx) > Math.abs(e.deltaY) || (e.shiftKey && e.deltaX === 0);
      if (!horizontal) return;
      // Consume the horizontal gesture so the page doesn't rubber-band sideways.
      e.preventDefault();
      if (Math.abs(dx) < STEP_THRESHOLD) return;
      const now = e.timeStamp || performance.now();
      if (now - lastStepAt < STEP_COOLDOWN_MS) return;
      lastStepAt = now;
      const dir = dx > 0 ? 1 : -1;
      setActivePage((p) => clampPage(p + dir, totalPagesRef.current));
    };
    // Non-passive so preventDefault actually suppresses the native horizontal
    // over-scroll (Chrome treats wheel listeners as passive by default).
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [fitActive, totalPages]);

  // ---- Touch-swipe paging (issue #73 polish #3, the cheap bonus) ----
  // A left/right swipe on the slide viewport pages the same way the wheel does. We
  // track the first touch's x and, on touchend, page if the horizontal travel beat
  // a threshold AND dominated the vertical travel (so a vertical scroll-swipe on an
  // internal widget isn't hijacked). Pure pointer math; no library.
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (e: ReactTouchEvent) => {
    const t = e.touches[0];
    if (t) touchStart.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: ReactTouchEvent) => {
    const start = touchStart.current;
    touchStart.current = null;
    if (!start || !fitActive || totalPages <= 1) return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    const SWIPE_THRESHOLD = 50;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(dy)) return;
    // A swipe LEFT (negative dx) goes to the NEXT page (content moves left), the
    // standard carousel convention.
    const dir = dx < 0 ? 1 : -1;
    setActivePage((p) => clampPage(p + dir, totalPagesRef.current));
  };

  // ---- RGL change handler ----
  // RGL hands us the edited layout for the active breakpoint plus the full
  // `allLayouts`. We persist the full set so every breakpoint round-trips. When
  // the stat strip is pinned, the grid only holds charts/panels, so we MERGE the
  // edited lg grid back over the pinned stats' saved placements (we don't want to
  // drop their geometry — the user may unpin later). Below fit, the grid is the
  // whole set so we persist as-is.
  //
  // THE INFINITE-LOOP FIX (issue #73). RGL fires `onLayoutChange` not just on a
  // genuine user drag/resize but on mount, breakpoint switch, vertical compaction,
  // AND every time we feed it a new `layouts` prop. Persisting from THAT handler
  // formed a feedback loop: persist → optimistic state update → re-feed RGL →
  // `onLayoutChange` → persist … . It never settled because RGL's vertical
  // compaction of an overlap-carrying layout can OSCILLATE between two equally-
  // valid packings (a 2-cycle, not a fixed point), so each re-emit genuinely
  // differs from the last → endless persists → React #185 ("maximum update depth
  // exceeded"). The robust break (how RGL apps normally persist): persist ONLY on
  // the actual user gestures — RGL's `onDragStop` / `onResizeStop` (and the
  // explicit add/remove paths) — never on the noisy `onLayoutChange`. So we use
  // `onLayoutChange` purely to CAPTURE the latest full layout into a ref (no
  // setState, no persist), and the stop handlers persist from that ref. A
  // structural-equality guard stays as a cheap belt-and-suspenders no-op filter.

  // Build the persistable per-breakpoint blob from RGL's full `allLayouts`,
  // applying the pinned-widget fold-back and the paged clamp (same transform the
  // fed layout uses, so the persisted geometry and the view-mode partition agree).
  const buildNext = (all: Layouts): Placements => {
    const next: Placements = {};
    for (const key of Object.keys(COLS) as Breakpoint[]) {
      const arr = all[key];
      if (!Array.isArray(arr)) continue;
      let edited = arr.map((l) => sanitize(l));
      // At lg, when the strip is shown, the grid excluded the PINNED tiles — fold
      // their existing saved page placements back so the persisted lg blob stays
      // complete (so unpinning, and md/sm/xs, keep each widget's page geometry).
      if (key === FIT_BREAKPOINT && pinActive) {
        const prevLg = layouts[FIT_BREAKPOINT] ?? [];
        const pinned = prevLg.filter((p) => pinnedIds.has(p.i));
        edited = [...pinned, ...edited];
      }
      // Clamp the edited lg grid to pages so a tile dragged across a boundary in
      // the (scrolling) customize canvas is re-banded — keeping the view-mode
      // partition straddle-free. Only the paged (lg, fit) breakpoint is clamped.
      if (key === FIT_BREAKPOINT && fitActive) {
        const grid = edited.filter((p) => gridIds.includes(p.i));
        const rest = edited.filter((p) => !gridIds.includes(p.i));
        edited = [...rest, ...clampToPagesSafe(grid, rowsPerPage)];
      }
      next[key] = edited;
    }
    // Carry the pinned strip's placements through a PAGE-grid persist untouched —
    // they ride the same blob under STRIP_KEY (issue #73 polish #4) and a page edit
    // must not drop them. Read from the saved blob (the authority) so a strip the
    // user arranged survives a later chart drag. `layouts` strips the key via
    // mergePlacements, so we pull it straight off savedPlacements.
    const strip = readStrip(savedPlacements);
    return strip ? withStrip(next, strip) : next;
  };

  // The latest full layout RGL has emitted (its post-compaction state), captured
  // on every `onLayoutChange` so the drag/resize-STOP handlers persist exactly
  // what RGL settled on — without persisting from `onLayoutChange` itself.
  const latestAll = useRef<Layouts | null>(null);
  const onLayoutChange = (_current: Layout[], all: Layouts) => {
    latestAll.current = all;
  };

  // Persist the current layout — called ONLY from genuine user gestures (drag/
  // resize stop). Bails if customizing is off or the blob is structurally equal
  // to what's already in state (a gesture that ended where it began).
  const persistFromGesture = (all: Layouts) => {
    if (!customizing) return;
    const next = buildNext(all);
    if (placementsEqual(next, layouts)) return;
    onPlacementsChange(next);
  };
  // RGL passes the active-breakpoint layout to the stop handlers; we merge it into
  // the latest captured `allLayouts` so every breakpoint still round-trips.
  const onGestureStop = (current: Layout[]) => {
    const bpKey = bp as string;
    const all: Layouts = { ...(latestAll.current ?? {}), [bpKey]: current };
    persistFromGesture(all);
  };

  // ---- The pinned strip's OWN persist (issue #73 polish #4) ----
  // The strip is a SEPARATE RGL grid from the paged canvas, so it has its own
  // drag/resize-STOP handler. It persists ONLY on a real gesture (the same crash-
  // safe discipline as the page grid — never on the noisy onLayoutChange), writing
  // the edited strip back into the layout blob under STRIP_KEY via withStrip while
  // leaving every breakpoint untouched. The structural-equality guard short-
  // circuits a no-op so the persist→re-feed loop can't run away (React #185).
  const onStripGestureStop = (current: Layout[]) => {
    if (!customizing) return;
    const edited = current.map((l) => sanitize(l));
    const next = withStrip(layouts, edited);
    if (placementsEqual(next, layouts)) return;
    onPlacementsChange(next);
  };

  // ---- The pinned top bar (its OWN editable RGL grid; issue #73 polish #4) ----
  // The bar is a SECOND RGL region — the pinned widgets (ANY category now: stats,
  // charts, the bills panel) are drag/resize/arrange-able within it in Customize
  // mode, with their own placements (stripPlacements, persisted under STRIP_KEY).
  // It's pinned ABOVE the paged slide-track and shows identically on every page.
  // Its height is MEASURED (stripRef) and subtracted from availH so the paged grid
  // fits below it. Uses a fixed STRIP_ROW_HEIGHT (content-sized, not viewport-
  // filling) and the same displacement+compaction model (CHANGE 2) as the page
  // grid so a strip card reorder pushes the others aside. The `ngrid-stat-strip` class keeps
  // any pinned stat cards' content un-clipped (globals.css), and `ngrid-pinned-bar`
  // carries the amber pinned highlight (the operator's "highlighted background").
  // We wrap in `min-w-0` so RGL's WidthProvider measures the column width correctly.
  const pinnedStrip = pinActive ? (
    <div ref={stripRef} className="shrink-0">
      <ResponsiveGrid
        className={`ngrid-rgl ngrid-stat-strip ngrid-pinned-bar ${customizing ? 'is-customizing' : ''}`}
        layouts={{ lg: stripPlacements, md: stripPlacements, sm: stripPlacements, xs: stripPlacements } as unknown as Layouts}
        breakpoints={RGL_BREAKPOINTS}
        // The strip is a fixed 12-col band at every breakpoint (it only renders at
        // the fit breakpoint, but RGL wants every configured breakpoint in `cols`).
        cols={{ lg: STRIP_COLS, md: STRIP_COLS, sm: STRIP_COLS, xs: STRIP_COLS }}
        rowHeight={STRIP_ROW_HEIGHT}
        margin={[MARGIN, MARGIN]}
        containerPadding={[0, 0]}
        isDraggable={customizing}
        isResizable={customizing}
        draggableCancel=".rgl-no-drag, button, a, input, label, select, textarea"
        // The strip uses the SAME displacement+compaction model as the page grid
        // (CHANGE 2): dragging a strip card makes the others move aside and the band
        // stays gap-collapsed. Horizontal compaction keeps the single-row strip
        // packed left without wrapping a card to a new row on a small nudge.
        compactType="horizontal"
        preventCollision={false}
        onDragStop={(layout) => onStripGestureStop(layout)}
        onResizeStop={(layout) => onStripGestureStop(layout)}
        measureBeforeMount={false}
        useCSSTransforms
      >
        {stripPlacements.map((p) => (
          <div key={p.i} className="ngrid-rgl-item">
            <WidgetCell
              type={p.i}
              host={host}
              customizing={customizing}
              onRemove={() => props.onRemoveWidget(p.i)}
              // This tile lives in the bar → it's pinned: show the amber highlight
              // (always) and an UNPIN affordance (in Customize only) (issue #73
              // polish #4).
              pinned
              canPin={customizing && !!props.onTogglePin}
              onTogglePin={() => props.onTogglePin?.(p.i)}
            />
          </div>
        ))}
      </ResponsiveGrid>
    </div>
  ) : null;

  // ---- Each page's OWN layout (the keystone: a bounded, rebased grid) ----
  // VIEW MODE renders ALL pages as horizontal slides (issue #73 polish #2), but
  // each slide is STILL its own bounded grid: paginatePlacements clamps every tile
  // wholly within one page band; rebaseToLocal subtracts the page's base row so the
  // page's grid starts at y=0. Each slide mounts just that page's widgets in a grid
  // whose height is exactly availH with maxRows = R, so a tile CANNOT be clipped at
  // a boundary — the slide IS the grid. We precompute every page's rebased
  // placements + ids so the slide-track can render them all.
  const pageViews = useMemo(
    () =>
      fitActive
        ? pages.map((pg) => {
            const placements = rebaseToLocal(pg, rowsPerPage);
            return { placements, ids: placements.map((p) => p.i) };
          })
        : [],
    [fitActive, pages, rowsPerPage]
  );

  // The FULL (clamped) canvas layouts for CUSTOMIZE / below-fit. At fit we feed the
  // grid-only lg placements (clamped to pages so a dragged-across tile re-bands);
  // below fit it's the merged per-breakpoint blob as-is (the page scrolls).
  const canvasLayouts: Placements = useMemo(() => {
    if (!fitActive) return layouts;
    const lg = clampToPagesSafe(gridLgPlacements, rowsPerPage);
    return { ...layouts, [FIT_BREAKPOINT]: lg };
  }, [fitActive, layouts, gridLgPlacements, rowsPerPage]);

  // A shared RGL builder so VIEW and CUSTOMIZE/scroll grids stay identical except
  // for the few axes that differ (which layout + ids, draggable, maxRows). Both run
  // DISPLACEMENT + VERTICAL COMPACTION (CHANGE 2): dragging a panel reflows the
  // others out of the way and the grid stays gap-collapsed; intentional spacing
  // comes from SPACER tiles, not free-floating gaps. The persist handlers only fire
  // on real gestures (drag/resize stop), so the static VIEW grid never persists.
  const buildGrid = (opts: {
    gridLayouts: Placements;
    ids: string[];
    draggable: boolean;
    maxRows?: number;
    gridKey?: string;
  }) => (
    <ResponsiveGrid
      key={opts.gridKey}
      className={`ngrid-rgl ${customizing ? 'is-customizing' : ''}`}
      layouts={opts.gridLayouts as unknown as Layouts}
      breakpoints={RGL_BREAKPOINTS}
      cols={RGL_COLS}
      rowHeight={rowHeight}
      maxRows={opts.maxRows}
      margin={[MARGIN, MARGIN]}
      containerPadding={[MARGIN, MARGIN]}
      isDraggable={opts.draggable}
      isResizable={opts.draggable}
      draggableCancel=".rgl-no-drag, button, a, input, label, select, textarea"
      // DISPLACEMENT + COMPACTION (CHANGE 2 — replaces the old free-placement
      // model). compactType="vertical" makes RGL pack tiles upward so the grid
      // stays gap-collapsed (no arbitrary floating gaps), and preventCollision=false
      // lets a dragged tile PUSH the others out of its way (they reflow around it)
      // instead of the drag stopping at the first collision. Together: reordering a
      // panel makes the rest move aside — the operator's "I want other panels to
      // move out of the way when reordering." Intentional spacing is created with
      // SPACER tiles (a real placement that holds a cell under compaction), not with
      // free-floating gaps. Adds/pins still drop sensibly: findFreeSlot lands the new
      // tile on an empty cell, and vertical compaction tidies it into place.
      compactType="vertical"
      preventCollision={false}
      onLayoutChange={onLayoutChange}
      onDragStop={(layout) => onGestureStop(layout)}
      onResizeStop={(layout) => onGestureStop(layout)}
      onBreakpointChange={(nbp) => setBp(nbp as Breakpoint)}
      measureBeforeMount={false}
      useCSSTransforms
    >
      {opts.ids.map((type) => (
        <div key={type} className="ngrid-rgl-item">
          <WidgetCell
            type={type}
            host={host}
            customizing={opts.draggable}
            onRemove={() => props.onRemoveWidget(type)}
            // A page tile is NOT pinned; in Customize it gets the "pin to top bar"
            // affordance (issue #73 polish #4). The pin button only shows when the
            // cell is customizing, so view-mode tiles are unaffected.
            pinned={false}
            canPin={opts.draggable && !!props.onTogglePin}
            onTogglePin={() => props.onTogglePin?.(type)}
          />
        </div>
      ))}
    </ResponsiveGrid>
  );

  // VIEW MODE (fit): a horizontal SLIDE-TRACK of all pages (issue #73 polish #2 —
  // a phone-home-screen side-scroll, NOT a vertical swap). The track is a flex row
  // of full-width slides translated by −activePage*100% with a CSS transition;
  // prev/next + dots drive activePage → the track slides. Each slide is its OWN
  // bounded grid (its rebased placements, maxRows = R), so the per-page-bounded
  // correctness is preserved — no tile is clipped at a page edge. Off-screen slides
  // are aria-hidden + pointer-events-none so they don't steal focus/tab order or
  // intercept clicks. The viewport is overflow-hidden so only the active slide
  // shows and the document never gains a horizontal scrollbar. RGL grids are heavy
  // but there are only ~2–3 pages, so rendering them all is fine.
  const slideTrack =
    fitActive && !customizing ? (
      // The slide viewport carries the trackpad horizontal-scroll + touch-swipe
      // paging handlers (issue #73 polish #3). The wheel listener is attached
      // imperatively (non-passive) in an effect via slideViewportRef so it can
      // preventDefault; touch is wired declaratively here.
      <div
        ref={slideViewportRef}
        className="ngrid-slide-viewport min-h-0 shrink-0 overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <div
          className="flex"
          style={{
            transform: `translateX(-${safePage * 100}%)`,
            transition: 'transform 280ms cubic-bezier(0.4, 0, 0.2, 1)',
          }}
        >
          {pageViews.map((pv, i) => {
            const isActive = i === safePage;
            return (
              <div
                key={`slide-${i}`}
                // Each slide is a full-width, non-shrinking column so the track is
                // exactly pageCount × 100% wide and the translate lands one slide
                // per step. min-w-0 lets RGL's WidthProvider measure the slide width.
                className={`w-full min-w-0 shrink-0 ${isActive ? '' : 'pointer-events-none'}`}
                style={{ flex: '0 0 100%' }}
                aria-hidden={!isActive}
              >
                <div className="min-h-0">
                  {buildGrid({
                    gridLayouts: { [FIT_BREAKPOINT]: pv.placements },
                    ids: pv.ids,
                    draggable: false,
                    maxRows: rowsPerPage,
                    // Key by page so each slide's RGL has its own stable instance —
                    // no internal layout/width state bleeds between slides.
                    gridKey: `page-${i}`,
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    ) : null;

  return (
    // Layout column. At fit (view mode) the parent pins the page (xl:h-dvh
    // xl:overflow-hidden), so this fills the remaining height and NEVER scrolls;
    // the pager moves between pages. In customize mode at fit, we allow the canvas
    // to scroll vertically so every page's widgets are reachable/editable, with
    // page-boundary guides. Below fit it's height:auto and the page scrolls.
    <div ref={containerRef} className={`flex min-h-0 w-full flex-col gap-2 ${fit ? 'xl:min-h-0 xl:flex-1' : ''}`}>
      {pinnedStrip}
      {slideTrack ? (
        <>
          {slideTrack}
          {/* The pager is fixed chrome INSIDE the pinned viewport — its real
              height is measured (pagerRef → pagerH) and reserved in availH so it's
              ALWAYS fully visible after any resize (issue #73 polish #1). We render
              the wrapper even on a single page (so it's measured), hiding the
              controls when there's nothing to page. */}
          <LayoutPager
            ref={pagerRef}
            pageCount={totalPages}
            activePage={safePage}
            setPage={(u) => setActivePage((p) => u(p))}
          />
        </>
      ) : fitActive && customizing ? (
        // Customize canvas: scrollable, with page-boundary guide lines so the user
        // can see where each page breaks while dragging tiles across them. The
        // guides sit at each page band's pixel offset (one band = R rows + their
        // margins, the same height a VIEW page fills).
        <div className="ngrid-customize-canvas relative min-h-0 flex-1 overflow-y-auto">
          <PageGuides
            pageCount={Math.max(totalPages, computePageCount(gridLgPlacements, rowsPerPage))}
            pageStep={rowsPerPage * (rowHeight + MARGIN)}
          />
          {buildGrid({ gridLayouts: canvasLayouts, ids: gridIds, draggable: true })}
        </div>
      ) : (
        // Below the fit breakpoint: the page scrolls normally, no pager —
        // today's mobile/md behaviour.
        buildGrid({ gridLayouts: canvasLayouts, ids: gridIds, draggable: customizing })
      )}
    </div>
  );
}

// Clamp wrapper that no-ops on an empty grid (paginatePlacements handles non-empty
// via clampToPages; we re-derive the clamped set here for the persisted blob + the
// fed layout so they agree). Imported clampToPages is pure; this just guards the
// rowsPerPage and keeps the call sites terse.
function clampToPagesSafe(placements: Placement[], rowsPerPage: number): Placement[] {
  if (placements.length === 0) return placements;
  // Reuse the engine's partition then flatten (it clamps internally), so a single
  // source of truth governs both the view partition and the persisted geometry.
  return paginatePlacements(placements, rowsPerPage).flat();
}

// Page-boundary guides for the customize canvas: faint dashed lines at each page
// break so the user sees where a tile spills to the next page. Pure presentational.
function PageGuides({ pageCount, pageStep }: { pageCount: number; pageStep: number }) {
  if (pageStep <= 0 || pageCount <= 1) return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-0" aria-hidden>
      {Array.from({ length: pageCount - 1 }).map((_, i) => (
        <div
          key={i}
          // A guide sits at each page band boundary (the RGL row-band pixel
          // offset = pageStep), so it lines up with where a tile would spill.
          className="absolute left-0 right-0 border-t border-dashed border-amber-500/25"
          style={{ top: (i + 1) * pageStep }}
        >
          <span className="absolute -top-2.5 right-1 rounded bg-slate-900/80 px-1 text-[10px] text-amber-400/70">
            page {i + 2}
          </span>
        </div>
      ))}
    </div>
  );
}

// The pager controls — prev/next arrows flanking page dots + an "n / total"
// label, the retired CockpitPager's pattern (reused per the issue brief). Pure
// presentational: the active page + setter are owned by WidgetLayout.
//
// forwardRef so WidgetLayout can MEASURE the pager's real height (issue #73 polish
// #1) and reserve it in availH — the pager is fixed chrome inside the pinned,
// overflow-hidden viewport, so its exact height must be reserved or the arrows get
// pushed below the fold. We render the (measured) wrapper even on a single page,
// but with no controls then, so it measures a near-zero band and wastes no height.
const LayoutPager = forwardRef<
  HTMLDivElement,
  {
    pageCount: number;
    activePage: number;
    setPage: (updater: (p: number) => number) => void;
  }
>(function LayoutPager({ pageCount, activePage, setPage }, ref) {
  // A single page needs no controls; render an (empty, ref'd) wrapper so it's still
  // measured at a near-zero height (the reservation stays honest without wasting
  // the full pager band on a one-page layout).
  if (pageCount <= 1) return <div ref={ref} className="shrink-0" aria-hidden />;
  return (
    <div ref={ref} className="flex shrink-0 items-center justify-center gap-3 pt-0.5">
      <button
        type="button"
        aria-label="Previous page"
        onClick={() => setPage((p) => clampPage(p - 1, pageCount))}
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700/70 bg-slate-800/40 text-slate-300 transition hover:bg-slate-700 hover:text-white"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <div className="flex items-center gap-1.5">
        {Array.from({ length: pageCount }).map((_, i) => (
          <button
            key={i}
            type="button"
            aria-label={`Page ${i + 1}`}
            aria-current={i === activePage}
            onClick={() => setPage(() => clampPage(i, pageCount))}
            className={`h-1.5 w-1.5 rounded-full transition ${i === activePage ? 'bg-amber-400' : 'bg-slate-600 hover:bg-slate-500'}`}
          />
        ))}
      </div>
      <span className="min-w-[3rem] text-center text-xs tabular-nums text-slate-400">
        {activePage + 1} / {pageCount}
      </span>
      <button
        type="button"
        aria-label="Next page"
        onClick={() => setPage((p) => clampPage(p + 1, pageCount))}
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700/70 bg-slate-800/40 text-slate-300 transition hover:bg-slate-700 hover:text-white"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </div>
  );
});

// Keep only the serializable placement fields off an RGL layout item (drop the
// transient `moved`/`static` RGL stamps so the persisted blob stays minimal).
function sanitize(l: Layout): Placement {
  const p: Placement = { i: l.i, x: l.x, y: l.y, w: l.w, h: l.h };
  if (typeof l.minW === 'number') p.minW = l.minW;
  if (typeof l.minH === 'number') p.minH = l.minH;
  return p;
}

// One placed widget's cell: the registry render plus, in Customize mode, a
// PIN/UNPIN toggle + a remove (×) affordance overlaid in the corner. The cell
// fills its grid box (h-full) so charts/the bills rail stretch to their placed
// height. A pinned cell (one living in the top bar) gets an amber highlight ring so
// it's obvious it's pinned — the operator's "highlighted background" (issue #73
// polish #4); the highlight shows in BOTH view and customize so the bar always
// reads as the pinned region.
function WidgetCell({
  type,
  host,
  customizing,
  onRemove,
  pinned = false,
  canPin = false,
  onTogglePin,
}: {
  type: string;
  host: WidgetHost;
  customizing: boolean;
  onRemove: () => void;
  // True when this cell lives in the pinned top bar (drives the highlight + the
  // affordance label: "Unpin" vs "Pin to top bar").
  pinned?: boolean;
  // True when the pin/unpin button should render (Customize mode + a handler wired).
  canPin?: boolean;
  onTogglePin?: () => void;
}) {
  const widget = getWidget(type);
  return (
    <div
      // The pinned highlight: an amber ring + faint amber wash over the cell so a
      // pinned widget is visually distinct from a paged one. `ring`/`bg` sit on the
      // cell wrapper (behind the widget's own card chrome) so it reads as a halo,
      // not a clash with the card border. Pointer-events untouched.
      className={`relative h-full min-h-0 w-full rounded-2xl ${
        pinned ? 'ngrid-pinned-cell ring-2 ring-amber-400/70 ring-offset-1 ring-offset-slate-950' : ''
      }`}
      data-pinned={pinned ? 'true' : undefined}
    >
      {customizing && (
        <div className="absolute right-1 top-1 z-20 flex items-center gap-1">
          {canPin && onTogglePin && (
            <button
              type="button"
              onClick={onTogglePin}
              title={pinned ? `Unpin ${widget.title} from the top bar` : `Pin ${widget.title} to the top bar`}
              aria-label={pinned ? `Unpin ${widget.title}` : `Pin ${widget.title} to top bar`}
              aria-pressed={pinned}
              className={`rgl-no-drag inline-flex h-6 w-6 items-center justify-center rounded-lg border shadow transition ${
                pinned
                  ? 'border-amber-400/70 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30'
                  : 'border-slate-600/70 bg-slate-900/90 text-slate-300 hover:bg-amber-900/40 hover:text-amber-200'
              }`}
            >
              {/* A pushpin glyph; filled-look when pinned, outline when not. */}
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 17v5" />
                <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
              </svg>
            </button>
          )}
          <button
            type="button"
            onClick={onRemove}
            title={`Remove ${widget.title}`}
            aria-label={`Remove ${widget.title}`}
            className="rgl-no-drag inline-flex h-6 w-6 items-center justify-center rounded-lg border border-rose-500/50 bg-slate-900/90 text-rose-300 shadow transition hover:bg-rose-900/60 hover:text-rose-100"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
      <div className={`h-full min-h-0 w-full ${customizing ? 'pointer-events-none select-none' : ''}`}>
        {widget.render(host)}
      </div>
    </div>
  );
}
