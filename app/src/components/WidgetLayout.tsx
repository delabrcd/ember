'use client';

// The react-grid-layout host (Phase E of the UI re-architecture, issue #73; RFC
// §3.3 + Decision 2). This is the component half of the layout engine: it takes
// the placed widgets, renders them through the registry inside RGL's Responsive
// grid, runs the runtime no-scroll fit, and drives Customize mode (drag / resize
// / add / remove). All the load-bearing MATH and the default-placement
// generation live in lib/layoutEngine.ts (pure, unit-tested) — this component
// only wires RGL + a ResizeObserver to those functions.
//
// REPLACES: the hand-laid fit-grid + CockpitPager + the FILL_BODY_CLASSES magic
// constant. The page-pinning/no-scroll guarantee is now COMPUTED from the
// measured chrome height, not a tuned `22.5rem`.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Responsive, WidthProvider, type Layout, type Layouts } from 'react-grid-layout';
import {
  BREAKPOINTS,
  COLS,
  DEFAULT_FIT_ROWS,
  FIT_BREAKPOINT,
  computeFitRowHeight,
  generateDefaultPlacements,
  mergePlacements,
  type Breakpoint,
  type Placement,
  type Placements,
} from '@/lib/layoutEngine';
import { getWidget, type WidgetHost } from '@/lib/widgets/registry';

// WidthProvider measures the container width for us so the grid is responsive
// without a hardcoded width (the standard RGL setup). Memoized at module scope so
// it isn't re-created each render (re-creating it remounts the whole grid).
const ResponsiveGrid = WidthProvider(Responsive);

// RGL margins (px). One value reused for x and y; `computeFitRowHeight` accounts
// for `rows + 1` of these vertically so the fit math matches RGL's real spacing.
// We also pass it as containerPadding so the outer gap equals the inter-row gap
// (the assumption the fit formula folds in).
const MARGIN = 8;

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
  // True in fit density (the old `prefs.density === 'fit'`). Only at the lg
  // breakpoint AND in fit density do we pin the page to the viewport and run the
  // no-scroll fit; otherwise the page scrolls (today's behaviour).
  fit: boolean;
  // Customize mode on/off — drag/resize + remove affordances + the palette.
  customizing: boolean;
  // The registry host every widget render reads (data resolvers, configs, etc.).
  host: WidgetHost;
  // Remove a widget from the placed set (the per-widget × affordance in a cell).
  // The host owns chart VISIBILITY (Phase D config) — it keeps `visible` in sync
  // for charts; stats/panels are removed purely by placement. (Adding back is the
  // palette's job, which lives in the chrome above the grid, so WidgetLayout
  // only needs the remove callback.)
  onRemoveWidget: (type: string) => void;
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
    host,
  } = props;

  // The placed widget ids, in render order (stats, charts, bills). The grid only
  // renders children for these; their positions come from the placements blob.
  const placedIds = useMemo(() => [...statIds, ...chartIds, ...panelIds], [statIds, chartIds, panelIds]);

  // The default placements that reproduce today's dashboard for the CURRENT
  // visible set. Recomputed when the set changes (a chart toggled, a card
  // appeared) so a newly-shown widget always has a default slot to fall into.
  const defaults = useMemo(
    () => generateDefaultPlacements({ statIds, chartIds, panelIds }),
    [statIds, chartIds, panelIds]
  );

  // The effective per-breakpoint layouts RGL renders: the saved placements
  // repaired against the fresh defaults (drop removed widgets, append newly-added
  // ones at their default slot), or the pure defaults when nothing is saved.
  // mergePlacements is the pure migration safety net (RFC §6).
  const layouts: Placements = useMemo(
    () => mergePlacements(savedPlacements ?? {}, defaults),
    [savedPlacements, defaults]
  );

  // FIRST-LOAD PERSIST (acceptance #1 + #5): an existing user has a Phase-D
  // layout with NO `layouts` yet → generate the default (above) and persist it
  // ONCE, so they open to today's dashboard AND can then customize (the saved
  // blob round-trips on reload). Guarded by a ref so we persist exactly once per
  // mount-with-no-saved-placements, never on every render.
  const persistedDefault = useRef(false);
  useEffect(() => {
    if (!savedPlacements && !persistedDefault.current && placedIds.length > 0) {
      persistedDefault.current = true;
      onPlacementsChange(defaults);
    }
    // Re-arm if the account changes underneath us (savedPlacements goes back to
    // undefined for a different account with no layout).
    if (savedPlacements) persistedDefault.current = true;
  }, [savedPlacements, defaults, onPlacementsChange, placedIds.length]);

  // ---- Active breakpoint + the no-scroll fit math ----
  // RGL tells us the active breakpoint via onBreakpointChange; we also seed it
  // from the initial width so the very first paint at lg already fits. Default to
  // the FIT breakpoint on the server/first paint (lg) so SSR matches the common
  // desktop case and there's no fit→scroll flash.
  const [bp, setBp] = useState<Breakpoint>(FIT_BREAKPOINT);

  // Measure the chrome height (everything ABOVE the grid) at runtime, so the fit
  // rowHeight is computed — never the old hand-tuned constant. The chrome ref is
  // attached by the parent (Dashboard) to the fixed top region; we ResizeObserver
  // it AND the window so a banner appearing or the window resizing recomputes.
  const [viewportH, setViewportH] = useState(0);
  const [chromeH, setChromeH] = useState(0);
  const chromeElRef = useRef<HTMLElement | null>(null);

  // The chrome element is whatever sits in the same flex column above this grid;
  // the parent marks it with [data-dashboard-chrome]. We look it up from our own
  // container's parent on mount and observe it. Done in a layout effect so the
  // first measured value is available before paint (minimizing any fit jump).
  const containerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // The chrome is the sibling(s) above us; the parent tags the wrapper region.
    const chrome = container.parentElement?.querySelector<HTMLElement>('[data-dashboard-chrome]') ?? null;
    chromeElRef.current = chrome;

    const measure = () => {
      setViewportH(window.innerHeight);
      setChromeH(chrome ? chrome.getBoundingClientRect().height : 0);
    };
    measure();

    const ro = new ResizeObserver(measure);
    if (chrome) ro.observe(chrome);
    window.addEventListener('resize', measure);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  // THE FIT ROW COUNT. We size a row so the DEFAULT COCKPIT — one stat band + two
  // chart rows (DEFAULT_FIT_ROWS) — fills the viewport, exactly like today's
  // 2-row fit chart grid. We deliberately do NOT divide by the LIVE row count: a
  // user with 7 charts has a 4-chart-row layout that physically can't fit one
  // viewport without squashing the charts to unreadability. Instead, the PAGE
  // stays pinned (no page scroll, acceptance #2) and the GRID REGION scrolls
  // internally for anything past the cockpit — so the default still LOOKS like
  // today's cockpit (stat band + tall charts) and the rest is a short scroll away,
  // replacing the old pager. (`placementRows` in layoutEngine is the live row
  // count, kept for tests/future callers; we deliberately don't size the row by
  // it, to keep charts readable.)
  const fitRows = DEFAULT_FIT_ROWS;

  // Only run the fit (and thus pin the page) at the lg breakpoint in fit density.
  // Everywhere else rowHeight is a comfortable fixed value and the page scrolls.
  const fitActive = fit && bp === FIT_BREAKPOINT;
  const rowHeight = useMemo(() => {
    if (!fitActive || viewportH === 0) {
      // Scrolling breakpoints (and the fit breakpoint before the first measure):
      // a fixed, readable row unit. CHART_ROWS (7) × this ≈ 280px charts, STAT_ROWS
      // (2) × this ≈ 80px cards — matching the old comfortable/below-xl heights.
      return 40;
    }
    return computeFitRowHeight({ viewportHeight: viewportH, measuredChrome: chromeH, rows: fitRows, marginY: MARGIN });
  }, [fitActive, viewportH, chromeH, fitRows]);

  // RGL change handler. RGL hands us the edited layout for the active breakpoint
  // plus the full `allLayouts`. We persist the full set so every breakpoint's
  // placements round-trip. Ignored while NOT customizing (the grid is static, so
  // RGL shouldn't fire structural changes, but we guard anyway) and during the
  // initial mount measure (RGL fires once on mount with the layout we gave it —
  // harmless to persist, but we skip it to avoid a redundant PUT).
  const mountedOnce = useRef(false);
  const onLayoutChange = (_current: Layout[], all: Layouts) => {
    if (!mountedOnce.current) {
      mountedOnce.current = true;
      return;
    }
    if (!customizing) return;
    // Narrow RGL's `Layouts` (a loose record) to our typed Placements: keep only
    // our breakpoints and the fields we persist.
    const next: Placements = {};
    for (const key of Object.keys(COLS) as Breakpoint[]) {
      const arr = all[key];
      if (Array.isArray(arr)) {
        next[key] = arr.map((l) => sanitize(l));
      }
    }
    onPlacementsChange(next);
  };

  return (
    // In fit mode at lg the PAGE is pinned (parent is xl:h-dvh xl:overflow-hidden),
    // so this grid region takes the remaining height (flex-1 min-h-0) and scrolls
    // INTERNALLY — the page never scrolls (acceptance #2), and a taller-than-
    // cockpit layout (e.g. 7 charts) is a short internal scroll, replacing the old
    // pager. Below xl / comfortable density it's height:auto and the page scrolls
    // normally (today's behaviour). Customize mode never pins (the parent unlocks),
    // so the palette + full grid are always reachable while editing.
    <div
      ref={containerRef}
      className={`min-h-0 w-full ${fit && !customizing ? 'xl:flex-1 xl:overflow-y-auto' : ''}`}
    >
      <ResponsiveGrid
        className={`ngrid-rgl ${customizing ? 'is-customizing' : ''}`}
        // Our typed Placements is structurally RGL's Layouts (a superset record);
        // RGL only reads the breakpoint keys it knows. The cast is the single,
        // documented boundary between our typed blob and RGL's loose record type.
        layouts={layouts as unknown as Layouts}
        breakpoints={RGL_BREAKPOINTS}
        cols={RGL_COLS}
        rowHeight={rowHeight}
        margin={[MARGIN, MARGIN]}
        containerPadding={[MARGIN, MARGIN]}
        // View mode is fully static (no drag/resize, no palette) — exactly the
        // old read-only dashboard. Customize mode flips both on.
        isDraggable={customizing}
        isResizable={customizing}
        // Don't let a drag start from inside a widget's own controls (the chart
        // Customize gear/expand, the bills links). The drag handle is the widget
        // chrome; interactive bits opt out via the cancel selector.
        draggableCancel=".rgl-no-drag, button, a, input, label, select, textarea"
        // Compact vertically so removing a widget pulls the rest up (the natural
        // dashboard feel); RGL's default.
        compactType="vertical"
        onLayoutChange={onLayoutChange}
        onBreakpointChange={(nbp) => setBp(nbp as Breakpoint)}
        measureBeforeMount={false}
        useCSSTransforms
      >
        {placedIds.map((type) => (
          <div key={type} className="ngrid-rgl-item">
            <WidgetCell type={type} host={host} customizing={customizing} onRemove={() => props.onRemoveWidget(type)} />
          </div>
        ))}
      </ResponsiveGrid>
    </div>
  );
}

// Keep only the serializable placement fields off an RGL layout item (drop the
// transient `moved`/`static` RGL stamps so the persisted blob stays minimal and
// stable). Pure-ish; lives here since it's the RGL→Placement boundary.
function sanitize(l: Layout): Placement {
  const p: Placement = { i: l.i, x: l.x, y: l.y, w: l.w, h: l.h };
  if (typeof l.minW === 'number') p.minW = l.minW;
  if (typeof l.minH === 'number') p.minH = l.minH;
  return p;
}

// One placed widget's cell: the registry render plus, in Customize mode, a
// remove (×) affordance overlaid in the corner. The cell fills its grid box
// (h-full) so charts/the bills rail stretch to their placed height.
function WidgetCell({
  type,
  host,
  customizing,
  onRemove,
}: {
  type: string;
  host: WidgetHost;
  customizing: boolean;
  onRemove: () => void;
}) {
  const widget = getWidget(type);
  return (
    <div className="relative h-full min-h-0 w-full">
      {customizing && (
        <button
          type="button"
          onClick={onRemove}
          title={`Remove ${widget.title}`}
          aria-label={`Remove ${widget.title}`}
          // rgl-no-drag so clicking remove doesn't start a drag.
          className="rgl-no-drag absolute right-1 top-1 z-20 inline-flex h-6 w-6 items-center justify-center rounded-lg border border-rose-500/50 bg-slate-900/90 text-rose-300 shadow transition hover:bg-rose-900/60 hover:text-rose-100"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      )}
      {/* In customize mode the whole cell is a drag surface; a subtle ring marks
          it as draggable. The widget itself renders normally. */}
      <div className={`h-full min-h-0 w-full ${customizing ? 'pointer-events-none select-none' : ''}`}>
        {widget.render(host)}
      </div>
    </div>
  );
}
