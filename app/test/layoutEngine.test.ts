import { describe, expect, it } from 'vitest';
import {
  COLS,
  DEFAULT_FIT_ROWS,
  PINNED_PAGE_ROWS,
  MIN_ROW_HEIGHT,
  STRIP_COLS,
  STRIP_KEY,
  clampToPages,
  computeFitRowHeight,
  computePageFit,
  findFreeSlot,
  generateDefaultPlacements,
  generateStripPlacements,
  mergePlacements,
  pageCount,
  paginatePlacements,
  placementRows,
  placementsEqual,
  readStrip,
  rebaseToLocal,
  withStrip,
  WIDE_STAT_TYPES,
  type Placement,
  type Placements,
} from '../src/lib/layoutEngine';

// Phase E (issue #73) layout-engine math tests. The load-bearing arithmetic +
// the default-placement generation are PURE (no React / RGL / DOM), so they're
// hand-calculated here, the same discipline cockpit.ts / dashboardLayout.ts /
// series.ts follow. The two risks we fence (RFC §6): the no-scroll fit must
// COMPUTE a height that fits the viewport, and the default generator must
// reproduce today's arrangement so an existing user opens to today's dashboard.

// A representative visible set: today's 8 stat cards, 7 charts, the bills panel.
const STATS = ['stat:a', 'stat:b', 'stat:c', 'stat:d', 'stat:e', 'stat:f', 'stat:g', 'stat:h'];
const CHARTS = ['chart:usage', 'chart:cost', 'chart:rates', 'chart:weather', 'chart:degreeDays', 'chart:normalized', 'chart:emissions'];
const PANELS = ['panel:bills'];
const INPUT = { statIds: STATS, chartIds: CHARTS, panelIds: PANELS };

// The REAL registry mins for the default widget set (mirrors registry.tsx's
// defaultSize.minW/minH; kept hand-written here so the layout-engine test stays
// PURE — no React/registry import). Stat cards minW=1 (the compact-stat-cards
// change: all 8 fit in ONE strip row), charts minW=3, the bills panel minW=3. minH
// values aren't load-bearing for the width-crush invariant but are included so the
// no-sub-min check covers H too (stat cards minH=2, the slim title+headline floor).
const MINS: Record<string, { minW: number; minH: number }> = {
  ...Object.fromEntries(STATS.map((i) => [i, { minW: 1, minH: 2 }])),
  ...Object.fromEntries(CHARTS.map((i) => [i, { minW: 3, minH: 3 }])),
  'panel:bills': { minW: 3, minH: 4 },
};
const INPUT_WITH_MINS = { ...INPUT, mins: MINS };

// ---------------------------------------------------------------------------
// 1. computeFitRowHeight — the no-scroll fit formula (replaces the magic const)
// ---------------------------------------------------------------------------
describe('computeFitRowHeight (hand-calculated)', () => {
  it('fills exactly: chrome + gridHeight == viewportHeight', () => {
    // viewport 900, chrome 300, 10 rows, margin 8.
    //   available = 900 - 300 = 600
    //   usable    = 600 - 8*(10+1) = 600 - 88 = 512
    //   rowHeight = 512 / 10 = 51.2
    const rh = computeFitRowHeight({ viewportHeight: 900, measuredChrome: 300, rows: 10, marginY: 8 });
    expect(rh).toBeCloseTo(51.2, 5);
    // The grid's total rendered height = rows*rh + (rows+1)*margin, and
    // chrome + that must equal the viewport (the no-scroll guarantee).
    const gridHeight = 10 * rh + (10 + 1) * 8;
    expect(300 + gridHeight).toBeCloseTo(900, 5);
  });

  it('at the fit targets (1366×768, 1280×800) a page fills the band with a sane row', () => {
    // computePageFit derives (R, rowHeight) from the measured band: it honours the
    // design budget (PINNED_PAGE_ROWS = 2 chart rows) but reduces R only if the
    // rows can't reach the readable floor; the result always FILLS the band
    // exactly (no scroll) at a row ≥ the floor.
    for (const vh of [768, 800]) {
      const availH = vh - 220 - 120 - 44; // chrome + pinned strip + pager allowance
      const { rows, rowHeight } = computePageFit({ availH, designRows: PINNED_PAGE_ROWS, marginY: 8 });
      // A readable row (≥ floor) and the page fills its band exactly.
      expect(rowHeight).toBeGreaterThanOrEqual(MIN_ROW_HEIGHT);
      expect(rows * rowHeight + (rows + 1) * 8).toBeCloseTo(availH, 5);
      // At least one chart's worth of rows fit per page (CHART_ROWS = 7), so a
      // page always shows a real chart rather than slivers.
      expect(rows).toBeGreaterThanOrEqual(7);
    }
  });

  it('clamps to a floor so a tiny/over-measured viewport never collapses to 0', () => {
    // Chrome larger than the viewport → negative usable → clamp to the floor
    // (the page scrolls a little, acceptable, instead of a 0-height chart).
    const rh = computeFitRowHeight({ viewportHeight: 400, measuredChrome: 800, rows: 16, marginY: 8 });
    expect(rh).toBe(MIN_ROW_HEIGHT);
  });

  it('guards a 0/negative row count (never divides by zero)', () => {
    const rh = computeFitRowHeight({ viewportHeight: 900, measuredChrome: 200, rows: 0, marginY: 8 });
    expect(Number.isFinite(rh)).toBe(true);
    expect(rh).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. generateDefaultPlacements — reproduce today's dashboard (acceptance #1)
// ---------------------------------------------------------------------------
describe('generateDefaultPlacements (hand-calculated)', () => {
  const placements = generateDefaultPlacements(INPUT);

  it('produces all four breakpoints, each placing every widget exactly once', () => {
    const allIds = [...STATS, ...CHARTS, ...PANELS];
    for (const bp of ['lg', 'md', 'sm', 'xs'] as const) {
      const arr = placements[bp]!;
      expect(arr.map((p) => p.i).sort()).toEqual([...allIds].sort());
    }
  });

  it('lg: a full-width stat band on top — 8 cards summing to 12 cols on row 0', () => {
    const lg = placements.lg!;
    const stats = lg.filter((p) => p.i.startsWith('stat:'));
    // All on the first band (y=0) with height STAT_ROWS, and widths summing to
    // the 12-col grid (today's full-width 8-up strip).
    expect(stats.every((p) => p.y === 0)).toBe(true);
    expect(stats.reduce((s, p) => s + p.w, 0)).toBe(COLS.lg);
    // 12/8 → four cards of w=2 and four of w=1 (the first 12%8=4 get the extra).
    expect(stats.filter((p) => p.w === 2).length).toBe(4);
    expect(stats.filter((p) => p.w === 1).length).toBe(4);
  });

  it('lg: charts in a 2×2 grid — half-width (6 cols) two-up at x=0 / x=6', () => {
    const lg = placements.lg!;
    const charts = lg.filter((p) => p.i.startsWith('chart:'));
    // Two columns at x=0 and x=6, each 6 cols wide → a full-width 2-up grid (the
    // 2×2 density iteration, issue #73). Two chart rows = four charts per page.
    expect(new Set(charts.map((p) => p.x))).toEqual(new Set([0, 6]));
    expect(charts.every((p) => p.w === 6)).toBe(true);
    // The bills panel is a full-width tile (12 cols) below the charts, one
    // page-band (PINNED_PAGE_ROWS) tall so it occupies its own page.
    const bills = lg.find((p) => p.i === 'panel:bills')!;
    expect(bills.x).toBe(0);
    expect(bills.w).toBe(COLS.lg);
    expect(bills.h).toBe(PINNED_PAGE_ROWS);
    // It sits below the last chart row: 7 charts → ceil(7/2)=4 chart rows.
    const lastChartBottom = Math.max(...charts.map((p) => p.y + p.h));
    expect(bills.y).toBeGreaterThanOrEqual(lastChartBottom);
  });

  it('xs (mobile): a single column — every widget at x=0, w=1, stacked in order', () => {
    const xs = placements.xs!;
    expect(xs.every((p) => p.x === 0 && p.w === 1)).toBe(true);
    // Order is stats → charts → panels, each below the previous (monotonic y).
    const ys = xs.map((p) => p.y);
    for (let k = 1; k < ys.length; k++) expect(ys[k]).toBeGreaterThanOrEqual(ys[k - 1]);
    // No two widgets overlap vertically (a clean stack).
    expect(new Set(ys).size).toBe(xs.length);
  });

  it('xs: column count is 1 so RGL collapses to a single column on mobile', () => {
    expect(COLS.xs).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2b. THE REGRESSION GUARD (issue #73): a DEFAULT placement is NEVER below a
//     widget's minW/minH. The buggy statBand split 12 cols across 8 stat cards →
//     four w=1 cards BELOW the minW=2 floor, so the factory default was a size RGL
//     would reject on resize → crushed, clipped, un-recreatable. With the registry
//     mins threaded in, no emitted default may be sub-min, at any breakpoint.
// ---------------------------------------------------------------------------
describe('default placements never fall below a widget min (issue #73)', () => {
  const placements = generateDefaultPlacements(INPUT_WITH_MINS);

  it('no placement at any breakpoint has w < minW or h < minH', () => {
    for (const bp of ['lg', 'md', 'sm', 'xs'] as const) {
      const cols = COLS[bp];
      for (const p of placements[bp]!) {
        // At xs the grid is one column, so minW collapses to 1 (a 2-/3-col min is
        // meaningless in a 1-col grid); above xs the registry min applies.
        const expectMinW = Math.min(MINS[p.i].minW, cols);
        expect(p.w, `${bp} ${p.i} w`).toBeGreaterThanOrEqual(expectMinW);
        // h ≥ the stamped minH (the tile is never defaulted below its own height
        // floor). The xs tiles clamp minH to the tile height, so this holds there too.
        if (typeof p.minH === 'number') {
          expect(p.h, `${bp} ${p.i} h`).toBeGreaterThanOrEqual(p.minH);
        }
        // The placement also CARRIES the min so RGL enforces the same floor.
        if (bp !== 'xs') {
          expect(p.minW, `${bp} ${p.i} minW stamp`).toBe(MINS[p.i].minW);
        }
      }
    }
  });

  it('every emitted minW/minH is itself satisfied by the tile (w≥minW, h≥minH)', () => {
    for (const bp of ['lg', 'md', 'sm', 'xs'] as const) {
      for (const p of placements[bp]!) {
        if (typeof p.minW === 'number') expect(p.w).toBeGreaterThanOrEqual(p.minW);
        if (typeof p.minH === 'number') expect(p.h).toBeGreaterThanOrEqual(p.minH);
      }
    }
  });

  it('lg stat strip is a SINGLE row (8 cards × minW=1 on 12 cols → all on y=0)', () => {
    const stats = placements.lg!.filter((p) => p.i.startsWith('stat:'));
    // ONE band row — the compact-stat-cards change: minW=1 lets all 8 fit at once.
    const rowYs = [...new Set(stats.map((p) => p.y))];
    expect(rowYs.length).toBe(1);
    expect(stats.every((p) => p.y === 0)).toBe(true);
    // Widths fill the 12-col strip edge to edge: 12/8 → four w=2 (the first 12%8=4
    // get the extra col) and four w=1, summing to 12.
    expect(stats.reduce((s, p) => s + p.w, 0)).toBe(COLS.lg);
    expect(stats.filter((p) => p.w === 2).length).toBe(4);
    expect(stats.filter((p) => p.w === 1).length).toBe(4);
    // Every card is ≥ its minW=1 (none below the floor).
    expect(stats.every((p) => p.w >= 1)).toBe(true);
  });

  it('the strip default (generateStripPlacements) is likewise a single row', () => {
    const strip = generateStripPlacements(STATS, MINS);
    const rowYs = [...new Set(strip.map((p) => p.y))];
    expect(rowYs.length).toBe(1); // all 8 on one row
    expect(strip.every((p) => p.w >= 1)).toBe(true);
    expect(strip.every((p) => p.minW === 1)).toBe(true);
    // The row fills the 12-col strip edge to edge.
    expect(strip.reduce((s, p) => s + p.w, 0)).toBe(STRIP_COLS);
  });

  it('mergePlacements self-heals a previously-persisted crushed default (h<minH → minH)', () => {
    // Simulate a layout an OLD generator persisted: a stat card with a crushed h=1
    // (below the slim minH=2). The merge against the correct default must lift it up
    // to the floor and stamp the mins.
    const def = generateDefaultPlacements(INPUT_WITH_MINS);
    const crushed: Placements = {
      lg: [{ i: 'stat:a', x: 0, y: 0, w: 1, h: 1 }], // crushed below minH=2
    };
    const merged = mergePlacements(crushed, def);
    const a = merged.lg!.find((p) => p.i === 'stat:a')!;
    expect(a.h).toBeGreaterThanOrEqual(2); // healed up to minH
    expect(a.minH).toBe(2);
    expect(a.minW).toBe(1);
    expect(a.w).toBeGreaterThanOrEqual(a.minW ?? 0);
    // A user's DELIBERATELY larger size is never shrunk by the heal.
    const big: Placements = { lg: [{ i: 'stat:a', x: 0, y: 0, w: 5, h: 9 }] };
    const bigMerged = mergePlacements(big, def).lg!.find((p) => p.i === 'stat:a')!;
    expect(bigMerged.w).toBe(5);
    expect(bigMerged.h).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 3. mergePlacements — the migration safety net (RFC §6)
// ---------------------------------------------------------------------------
describe('mergePlacements (hand-calculated)', () => {
  const def = generateDefaultPlacements(INPUT);

  it('null / garbage saved → the pure default for every breakpoint', () => {
    expect(mergePlacements(null, def)).toEqual(def);
    expect(mergePlacements('nope', def)).toEqual(def);
    expect(mergePlacements(42, def)).toEqual(def);
  });

  it('keeps a saved placement (user-edited x/y/w/h) for a still-known widget', () => {
    const saved: Placements = {
      lg: [{ i: 'chart:cost', x: 7, y: 3, w: 5, h: 9 }],
    };
    const merged = mergePlacements(saved, def);
    const cost = merged.lg!.find((p) => p.i === 'chart:cost')!;
    // The user's edited geometry survives verbatim.
    expect(cost).toMatchObject({ x: 7, y: 3, w: 5, h: 9 });
    // Every other known widget is appended at its default slot (none lost).
    expect(merged.lg!.map((p) => p.i).sort()).toEqual(def.lg!.map((p) => p.i).sort());
  });

  it('drops an unknown saved widget (removed/renamed) and appends a newly-added one', () => {
    // Saved has a widget that no longer exists, and is MISSING a chart added since.
    const reducedDef = generateDefaultPlacements({
      statIds: STATS,
      chartIds: CHARTS, // current set includes chart:emissions
      panelIds: PANELS,
    });
    const saved: Placements = {
      lg: [
        { i: 'chart:gone', x: 0, y: 0, w: 4, h: 7 }, // unknown → dropped
        { i: 'chart:usage', x: 0, y: 2, w: 4, h: 7 }, // known → kept
      ],
    };
    const merged = mergePlacements(saved, reducedDef);
    const ids = merged.lg!.map((p) => p.i);
    expect(ids).not.toContain('chart:gone'); // dropped
    expect(ids).toContain('chart:usage'); // kept
    expect(ids).toContain('chart:emissions'); // appended (newly available)
    // No duplicates.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('a missing/garbage saved breakpoint falls back to that default', () => {
    const saved: Placements = { lg: [{ i: 'chart:cost', x: 0, y: 0, w: 4, h: 7 }] };
    const merged = mergePlacements(saved, def);
    // md/sm/xs had nothing saved → exactly the defaults.
    expect(merged.md).toEqual(def.md);
    expect(merged.xs).toEqual(def.xs);
  });

  it('drops malformed saved items (missing numeric fields)', () => {
    const saved = { lg: [{ i: 'chart:cost' }, { x: 1, y: 1, w: 1, h: 1 }, 'junk', null] } as unknown;
    const merged = mergePlacements(saved, def);
    // Neither malformed entry is kept as a saved override; chart:cost falls back
    // to its default placement (appended), and the whole set is still complete.
    expect(merged.lg!.map((p) => p.i).sort()).toEqual(def.lg!.map((p) => p.i).sort());
  });
});

// ---------------------------------------------------------------------------
// 4. placementRows — the live row count the fit math divides by
// ---------------------------------------------------------------------------
describe('placementRows (hand-calculated)', () => {
  it('returns max(y+h) across placements', () => {
    const ps: Placement[] = [
      { i: 'a', x: 0, y: 0, w: 2, h: 2 },
      { i: 'b', x: 0, y: 2, w: 4, h: 7 }, // bottom = 9
      { i: 'c', x: 4, y: 2, w: 4, h: 7 }, // bottom = 9
    ];
    expect(placementRows(ps)).toBe(9);
  });

  it('an empty/undefined layout is a safe 1 (never divides by zero)', () => {
    expect(placementRows([])).toBe(1);
    expect(placementRows(undefined)).toBe(1);
  });

  it('the default cockpit spans more than one page budget at lg', () => {
    // DEFAULT_FIT_ROWS = stat band (STAT_ROWS) + two chart rows (2*CHART_ROWS),
    // the per-PAGE row budget the fit math targets; the live row count just tracks
    // the real (multi-page) layout, which is taller because the bills panel sits
    // a full page-band below the charts.
    const lg = generateDefaultPlacements(INPUT).lg!;
    // A 2-chart layout: stat band + one chart row + the full-width bills panel
    // (PINNED_PAGE_ROWS tall) below it. The bills panel's bottom is the row count.
    const twoCharts = generateDefaultPlacements({
      statIds: STATS,
      chartIds: ['chart:usage', 'chart:cost'],
      panelIds: PANELS,
    }).lg!;
    // STAT_ROWS(2) + 1 chart row (CHART_ROWS=7) → bills at y=9, h=PINNED_PAGE_ROWS
    // (14) → bottom 23.
    expect(placementRows(twoCharts)).toBe(2 + 7 + PINNED_PAGE_ROWS);
    // (sanity: the full 7-chart set is taller still, since charts wrap to 4 rows.)
    expect(placementRows(lg)).toBeGreaterThan(DEFAULT_FIT_ROWS);
  });
});

// ---------------------------------------------------------------------------
// 5. PAGINATION — the phone-home-screen no-scroll fit (issue #73 iteration)
// ---------------------------------------------------------------------------
describe('computePageFit — the keystone (R, rowHeight) derivation (hand-calculated)', () => {
  it('honours the design budget and sizes the row so R rows EXACTLY fill the band', () => {
    // A comfortable laptop band easily fits the design budget (14 rows). usable =
    // 560 − 8*(14+1) = 440; rowHeight = 440/14 = 31.43 → R rows fill exactly.
    const { rows, rowHeight } = computePageFit({ availH: 560, designRows: 14, marginY: 8 });
    expect(rows).toBe(14);
    expect(rowHeight).toBeCloseTo(440 / 14, 5);
    // The defining no-scroll guarantee: R*rowHeight + (R+1)*margin == availH.
    expect(rows * rowHeight + (rows + 1) * 8).toBeCloseTo(560, 5);
  });

  it('NEVER grows R past the design budget even when the band could fit more', () => {
    // A tall viewport could fit far more than 4 rows, but the design budget caps
    // R at 4 so the common case lands on the intended cockpit (no extra row).
    const { rows } = computePageFit({ availH: 2000, designRows: 4, marginY: 8 });
    expect(rows).toBe(4);
  });

  it('REDUCES R (adapts, never scrolls) when the band is too short for a readable row', () => {
    // A short band can't give 14 rows ≥ the floor (24px): 14 rows would need
    // 14*24 + 15*8 = 456px, but the band is only 300. computePageFit shrinks R
    // until the fill height clears the floor, so the page still fills without
    // scroll. We assert it picked the LARGEST such R: at R rows the fill height
    // ≥ floor, and at R+1 it would drop below.
    const availH = 300;
    const { rows, rowHeight } = computePageFit({ availH, designRows: 14, marginY: 8 });
    expect(rowHeight).toBeGreaterThanOrEqual(MIN_ROW_HEIGHT);
    expect(rows).toBeLessThan(14);
    // R rows fill the band exactly (no scroll).
    expect(rows * rowHeight + (rows + 1) * 8).toBeCloseTo(availH, 5);
    // R+1 would have fallen below the floor (so R is the largest fitting budget).
    const next = (availH - (rows + 2) * 8) / (rows + 1);
    expect(next).toBeLessThan(MIN_ROW_HEIGHT);
  });

  it('clamps to the floor at R=1 on a pathologically tiny band (graceful scroll)', () => {
    // Even one row can't reach the floor in a 20px band → clamp to the floor (it
    // then scrolls a hair, the documented degradation) rather than collapsing.
    const { rows, rowHeight } = computePageFit({ availH: 20, designRows: 14, marginY: 8 });
    expect(rows).toBe(1);
    expect(rowHeight).toBe(MIN_ROW_HEIGHT);
  });

  it('rowQuantum keeps R a multiple of a chart row (no partial-row wasted band)', () => {
    // designRows=14, quantum=7 (CHART_ROWS): a band that fits 14 rows ≥ floor keeps
    // R=14 (a 2×2). A band too short for 14 but fine for 7 drops to R=7 (a 1×2) —
    // NEVER an in-between like 11 that would split a chart row across pages.
    const big = computePageFit({ availH: 560, designRows: 14, marginY: 8, rowQuantum: 7 });
    expect(big.rows).toBe(14);
    expect(big.rows % 7).toBe(0);
    // 14 rows need 14*24 + 15*8 = 456px at the floor; 300px can't, but 7 rows need
    // 7*24 + 8*8 = 232px ≤ 300 → R snaps to 7 (a whole chart row), not 8–13.
    const small = computePageFit({ availH: 300, designRows: 14, marginY: 8, rowQuantum: 7 });
    expect(small.rows).toBe(7);
    // R rows still fill the band exactly (no scroll).
    expect(small.rows * small.rowHeight + (small.rows + 1) * 8).toBeCloseTo(300, 5);
  });

  it('rowQuantum falls below one quantum only when a single chart row cannot fit', () => {
    // A band too short for even one chart row (7 rows need 232px at the floor) drops
    // to a sub-quantum R so something still fills the band.
    const { rows, rowHeight } = computePageFit({ availH: 120, designRows: 14, marginY: 8, rowQuantum: 7 });
    expect(rows).toBeLessThan(7);
    expect(rows).toBeGreaterThanOrEqual(1);
    expect(rowHeight).toBeGreaterThanOrEqual(MIN_ROW_HEIGHT);
  });
});

describe('rebaseToLocal — a page renders as its OWN grid at y=0 (hand-calculated)', () => {
  it('subtracts the page band base so the page starts at local y=0', () => {
    // rpp=7. Page-1 tiles (global rows 7–13) rebase to local rows 0–6.
    const page1: Placement[] = [
      { i: 'a', x: 0, y: 7, w: 6, h: 7 },
      { i: 'b', x: 6, y: 7, w: 6, h: 7 },
    ];
    expect(rebaseToLocal(page1, 7)).toEqual([
      { i: 'a', x: 0, y: 0, w: 6, h: 7 },
      { i: 'b', x: 6, y: 0, w: 6, h: 7 },
    ]);
  });

  it('PRESERVES an intra-band gap above the page (the gap survives the rebase)', () => {
    // rpp=14. A page-1 tile that starts a few rows INTO its band (global y=17,
    // band base 14) keeps that 3-row offset locally (local y=3) — the gap above
    // it is part of the layout, not stripped.
    const page: Placement[] = [{ i: 'a', x: 0, y: 17, w: 6, h: 7 }];
    expect(rebaseToLocal(page, 14)).toEqual([{ i: 'a', x: 0, y: 3, w: 6, h: 7 }]);
  });

  it('is a no-op on page 0 (already at the origin band)', () => {
    const page0: Placement[] = [{ i: 'a', x: 0, y: 0, w: 6, h: 7 }];
    expect(rebaseToLocal(page0, 7)).toEqual(page0);
  });

  it('an empty page rebases to empty', () => {
    expect(rebaseToLocal([], 7)).toEqual([]);
  });

  it('a paginated page rebased is a self-contained grid that fits within R rows', () => {
    // End-to-end: partition the default cockpit grid at the pinned budget, then
    // rebase each page. Every rebased page sits within [0, R) — the bound the
    // VIEW grid (maxRows=R, height=availH) renders without clipping.
    const lg = generateDefaultPlacements(INPUT).lg!;
    const grid = lg.filter((p) => !p.i.startsWith('stat:'));
    const minY = Math.min(...grid.map((p) => p.y));
    const rebasedGrid = grid.map((p) => ({ ...p, y: p.y - minY }));
    const pages = paginatePlacements(rebasedGrid, PINNED_PAGE_ROWS);
    for (const pg of pages) {
      const local = rebaseToLocal(pg, PINNED_PAGE_ROWS);
      for (const p of local) {
        expect(p.y).toBeGreaterThanOrEqual(0);
        expect(p.y + p.h).toBeLessThanOrEqual(PINNED_PAGE_ROWS);
      }
    }
  });
});

describe('pageCount (hand-calculated)', () => {
  it('is the last occupied band + 1', () => {
    const ps: Placement[] = [
      { i: 'a', x: 0, y: 0, w: 4, h: 7 }, // page 0 (rows 0–6, rpp=7)
      { i: 'b', x: 4, y: 7, w: 4, h: 7 }, // page 1 (rows 7–13)
    ];
    expect(pageCount(ps, 7)).toBe(2);
  });
  it('a tile ending exactly on a band boundary does NOT start a new page', () => {
    // h=7 at y=0 ends at row 7 (exclusive), i.e. bottom=7 → ceil(7/7)=1 page.
    expect(pageCount([{ i: 'a', x: 0, y: 0, w: 4, h: 7 }], 7)).toBe(1);
  });
  it('empty layout is a single page', () => {
    expect(pageCount([], 7)).toBe(1);
    expect(pageCount(undefined, 7)).toBe(1);
  });
});

describe('clampToPages — no tile straddles a page boundary (hand-calculated)', () => {
  it('keeps tiles that already fit within a page band', () => {
    const ps: Placement[] = [
      { i: 'a', x: 0, y: 0, w: 4, h: 7 },
      { i: 'b', x: 4, y: 0, w: 4, h: 7 },
    ];
    expect(clampToPages(ps, 7)).toEqual(ps);
  });
  it('pushes a straddling tile down to the next page band', () => {
    // rpp=7; a tile at y=4 h=7 would span rows 4–10 (crosses the row-7 boundary).
    // It must be re-banded to start at row 7 (the next page), height preserved.
    const out = clampToPages([{ i: 'a', x: 0, y: 4, w: 4, h: 7 }], 7);
    expect(out[0]).toMatchObject({ i: 'a', y: 7, h: 7 });
  });
  it('clamps a tile taller than a whole page to the page height', () => {
    // rpp=7; a 10-row tile can never fit one band → clamp h to 7.
    const out = clampToPages([{ i: 'a', x: 0, y: 0, w: 4, h: 10 }], 7);
    expect(out[0].h).toBe(7);
  });
  it('stacks re-banded tiles in a band instead of overlapping', () => {
    // Two tiles that both want to spill onto page 1 must not overlap there.
    const out = clampToPages(
      [
        { i: 'a', x: 0, y: 5, w: 4, h: 5 }, // spills → page 1 (y=7)
        { i: 'b', x: 0, y: 6, w: 4, h: 5 }, // spills → page 1, below a
      ],
      7
    );
    const a = out.find((p) => p.i === 'a')!;
    const b = out.find((p) => p.i === 'b')!;
    // No vertical overlap: b starts at or after a's bottom.
    expect(b.y).toBeGreaterThanOrEqual(a.y + a.h);
  });
});

describe('paginatePlacements — partition into pages (hand-calculated)', () => {
  it('buckets tiles by row band; fills page 1 then spills to page 2', () => {
    const ps: Placement[] = [
      { i: 'a', x: 0, y: 0, w: 4, h: 7 }, // page 0
      { i: 'b', x: 4, y: 0, w: 4, h: 7 }, // page 0
      { i: 'c', x: 0, y: 7, w: 4, h: 7 }, // page 1
    ];
    const pages = paginatePlacements(ps, 7);
    expect(pages.length).toBe(2);
    expect(pages[0].map((p) => p.i).sort()).toEqual(['a', 'b']);
    expect(pages[1].map((p) => p.i)).toEqual(['c']);
  });
  it('a straddling tile is re-banded so it lands wholly on one page', () => {
    const pages = paginatePlacements(
      [
        { i: 'a', x: 0, y: 0, w: 4, h: 7 }, // page 0
        { i: 'b', x: 0, y: 4, w: 4, h: 7 }, // straddles → page 1
      ],
      7
    );
    // Every tile sits within exactly one page's row band (no straddler).
    pages.forEach((pg, i) => {
      for (const p of pg) {
        expect(Math.floor(p.y / 7)).toBe(i);
        expect(p.y + p.h).toBeLessThanOrEqual((i + 1) * 7);
      }
    });
  });
  it('an empty grid is a single empty page', () => {
    expect(paginatePlacements([], 7)).toEqual([[]]);
  });
});

// ---------------------------------------------------------------------------
// The Customize-mode infinite-render-loop fix (issue #73): the persist guard.
// ---------------------------------------------------------------------------
//
// The crash was a feedback loop — persist → re-feed RGL → onLayoutChange →
// persist … — that never reached a fixed point. The component now breaks it by
// persisting ONLY when the freshly-built blob structurally differs from what's
// already in state. Two pure properties underwrite that being a correct break:
//   1. clampToPages is IDEMPOTENT — applying it to its own output yields the same
//      result, so feeding the persisted (clamped) grid back produces an identical
//      fed layout (a true fixed point); and
//   2. placementsEqual correctly detects no-change vs a real edit, so a genuine
//      drag/resize still persists while a no-op re-emit short-circuits.
describe('clampToPages is idempotent (the round-trip reaches a fixed point)', () => {
  it('clamp(clamp(x)) === clamp(x) for a layout with straddlers + overflow', () => {
    const ps: Placement[] = [
      { i: 'a', x: 0, y: 0, w: 4, h: 7 }, // fits page 0
      { i: 'b', x: 4, y: 4, w: 4, h: 7 }, // straddles → re-banded to page 1
      { i: 'c', x: 0, y: 6, w: 4, h: 5 }, // straddles → page 1, stacks below b
      { i: 'd', x: 0, y: 0, w: 4, h: 10 }, // taller than a page → height clamped
    ];
    const once = clampToPages(ps, 7);
    const twice = clampToPages(once, 7);
    // Applying the clamp to its already-clamped output changes nothing.
    expect(twice).toEqual(once);
  });
  it('the real default cockpit grid is a clamp fixed point at the pinned budget', () => {
    const lg = generateDefaultPlacements(INPUT).lg!;
    const grid = lg.filter((p) => !p.i.startsWith('stat:'));
    const once = clampToPages(grid, PINNED_PAGE_ROWS);
    expect(clampToPages(once, PINNED_PAGE_ROWS)).toEqual(once);
  });
});

describe('placementsEqual — the no-change detector that breaks the loop', () => {
  const A: Placement[] = [
    { i: 'chart:cost', x: 0, y: 0, w: 4, h: 7, minW: 2, minH: 2 },
    { i: 'chart:usage', x: 4, y: 0, w: 4, h: 7, minW: 2, minH: 2 },
  ];
  it('equal regardless of array order (RGL may re-emit in any order)', () => {
    const reordered = [A[1], A[0]];
    expect(placementsEqual({ lg: A }, { lg: reordered })).toBe(true);
  });
  it('ignores extra RGL stamps not in the geometry (only i/x/y/w/h/min compared)', () => {
    // A re-emit carrying transient `moved`/`static` flags is still "no change".
    const stamped = A.map((p) => ({ ...p, moved: true, static: false }) as unknown as Placement);
    expect(placementsEqual({ lg: A }, { lg: stamped })).toBe(true);
  });
  it('detects a moved tile (a real user drag → must persist)', () => {
    const moved = [{ ...A[0], y: 7 }, A[1]];
    expect(placementsEqual({ lg: A }, { lg: moved })).toBe(false);
  });
  it('detects a resized tile (a real user resize → must persist)', () => {
    const resized = [{ ...A[0], h: 9 }, A[1]];
    expect(placementsEqual({ lg: A }, { lg: resized })).toBe(false);
  });
  it('detects a removed tile (different length → must persist)', () => {
    expect(placementsEqual({ lg: A }, { lg: [A[0]] })).toBe(false);
  });
  it('a present-but-empty breakpoint equals an absent one (both render nothing)', () => {
    expect(placementsEqual({ lg: A, md: [] }, { lg: A })).toBe(true);
  });
  it('compares every breakpoint, not just lg', () => {
    const md: Placement[] = [{ i: 'chart:cost', x: 0, y: 0, w: 4, h: 7 }];
    const mdMoved: Placement[] = [{ i: 'chart:cost', x: 0, y: 7, w: 4, h: 7 }];
    expect(placementsEqual({ lg: A, md }, { lg: A, md: mdMoved })).toBe(false);
  });
});

describe('the default cockpit paginates cleanly at the pinned page budget', () => {
  it('7 charts + bills panel spill to a second page below a pinned stat strip', () => {
    // With the strip pinned, the paged area is PINNED_PAGE_ROWS (= 2 chart rows).
    // The default lg layout's charts+bills (4 chart rows + a full-page bills tile)
    // therefore span more than one page → the pager appears.
    const lg = generateDefaultPlacements(INPUT).lg!;
    const grid = lg.filter((p) => !p.i.startsWith('stat:')); // charts + bills
    const pages = paginatePlacements(grid, PINNED_PAGE_ROWS);
    expect(pages.length).toBeGreaterThan(1);
    // And no tile straddles a page boundary after the clamp.
    pages.forEach((pg, i) => {
      for (const p of pg) expect(p.y + p.h).toBeLessThanOrEqual((i + 1) * PINNED_PAGE_ROWS);
    });
  });

  it('packs a 2×2 of charts (4 charts) on page 1 at the pinned budget (issue #73 density)', () => {
    // The operator decision: ~4 charts per page in a 2×2, so the 7 charts span
    // ≈2 pages of charts rather than ~5 sparse pages. With the stat strip pinned,
    // the paged area is PINNED_PAGE_ROWS (= 2 chart rows). The lg charts (half-
    // width, two-up) therefore put four charts (two rows × two columns) on page 1.
    const lg = generateDefaultPlacements(INPUT).lg!;
    // The grid below a pinned strip is charts + bills, REBASED to start at row 0
    // (WidgetLayout drops the stat-band offset when the strip is pinned).
    const grid = lg.filter((p) => !p.i.startsWith('stat:'));
    const minY = Math.min(...grid.map((p) => p.y));
    const rebased = grid.map((p) => ({ ...p, y: p.y - minY }));
    const pages = paginatePlacements(rebased, PINNED_PAGE_ROWS);
    // Page 1 holds a 2×2 of charts (exactly four chart tiles).
    const page1Charts = pages[0].filter((p) => p.i.startsWith('chart:'));
    expect(page1Charts.length).toBe(4);
    // They form a 2×2: two columns (x ∈ {0, 6}) over two rows (y ∈ {0, CHART_ROWS}).
    expect(new Set(page1Charts.map((p) => p.x))).toEqual(new Set([0, 6]));
    expect(new Set(page1Charts.map((p) => p.y)).size).toBe(2);
    // The 7 charts span ~2 chart pages (≤3), not the old ~5. The bills panel adds
    // at most one more page, so the whole grid paginates to ~2–3 pages.
    const chartPages = pages.filter((pg) => pg.some((p) => p.i.startsWith('chart:'))).length;
    expect(chartPages).toBeLessThanOrEqual(2);
    expect(pages.length).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// THE CUSTOMIZABLE PINNED STRIP (issue #73 polish #4) — its own placements blob.
// ---------------------------------------------------------------------------
//
// The pinned stat strip is now its own editable RGL grid. Its placements ride the
// SAME layout blob under a reserved (non-breakpoint) key STRIP_KEY, so there's no
// schema change and the strip survives the same PUT as the page grid. These tests
// fence the pure side: the default is today's 8-across band; the strip key reads/
// writes without touching the real breakpoints; placementsEqual sees strip edits.
describe('generateStripPlacements — the EVEN strip default (CHANGE 1)', () => {
  it('lays the 8 stat cards as ONE row of EQUAL-width cards filling the 24-col strip', () => {
    const strip = generateStripPlacements(STATS);
    // One band: every card on y=0 (the single-row strip).
    expect(strip.every((p) => p.y === 0)).toBe(true);
    expect(strip.length).toBe(STATS.length);
    // EVEN widths: 24 / 8 = 3 cols each, all identical (the operator's "evenly
    // spaced" ask — no mixed w=1/w=2). The widths sum to the full 24-col strip with
    // no remainder, so the row fills edge to edge.
    expect(STRIP_COLS).toBe(24);
    expect(strip.every((p) => p.w === 3)).toBe(true);
    expect(strip.reduce((s, p) => s + p.w, 0)).toBe(STRIP_COLS);
    // Cards tile left to right with no overlap (x = 0, 3, 6, …, 21).
    expect(strip.map((p) => p.x)).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
  });

  it('is even regardless of card content (no WIDE-content +1 distribution any more)', () => {
    // The real 8-card set, in display order: every card is the SAME width now —
    // the yoy/rate/budget cards no longer get a wider slot (the strip is even and
    // yoy's text was compacted to fit the even width instead).
    const real = [
      'stat:latestBill', 'stat:lifetimeSpend', 'stat:elecRate', 'stat:gasRate',
      'stat:nextBillEstimate', 'stat:emissions', 'stat:yoy', 'stat:budget',
    ];
    const strip = generateStripPlacements(real);
    expect(strip.every((p) => p.y === 0)).toBe(true); // single row
    expect(strip.reduce((s, p) => s + p.w, 0)).toBe(STRIP_COLS);
    const widths = new Set(strip.map((p) => p.w));
    expect(widths.size).toBe(1); // all equal
    expect([...widths][0]).toBe(3);
    // The retired WIDE set no longer affects placement (it's empty now).
    expect(WIDE_STAT_TYPES.size).toBe(0);
  });

  it('stays even for other divisible card counts (6 → 4 each, 4 → 6, 3 → 8, 2 → 12)', () => {
    const counts: Record<number, number> = { 6: 4, 4: 6, 3: 8, 2: 12 };
    for (const [n, w] of Object.entries(counts)) {
      const ids = Array.from({ length: Number(n) }, (_, i) => `stat:s${i}`);
      const strip = generateStripPlacements(ids, Object.fromEntries(ids.map((i) => [i, { minW: 1, minH: 2 }])));
      expect(strip.every((p) => p.w === w)).toBe(true);
      expect(strip.reduce((s, p) => s + p.w, 0)).toBe(STRIP_COLS);
      expect(strip.every((p) => p.y === 0)).toBe(true);
    }
  });

  it('an empty stat set yields an empty strip', () => {
    expect(generateStripPlacements([])).toEqual([]);
  });
});

describe('readStrip / withStrip — the reserved strip key round-trips', () => {
  const strip: Placement[] = [
    { i: 'stat:a', x: 0, y: 0, w: 3, h: 3 },
    { i: 'stat:b', x: 3, y: 0, w: 3, h: 3 },
  ];

  it('withStrip stores under STRIP_KEY without touching real breakpoints', () => {
    const base: Placements = { lg: [{ i: 'chart:cost', x: 0, y: 0, w: 6, h: 7 }] };
    const out = withStrip(base, strip);
    // The lg breakpoint is untouched; the strip lands under the reserved key.
    expect(out.lg).toEqual(base.lg);
    expect(out[STRIP_KEY]).toEqual(strip);
  });

  it('readStrip pulls the strip back out (and is undefined when absent/garbage)', () => {
    expect(readStrip(withStrip({}, strip))).toEqual(strip);
    expect(readStrip({})).toBeUndefined();
    expect(readStrip(undefined)).toBeUndefined();
    // A non-array under the key reads as absent (defensive).
    expect(readStrip({ [STRIP_KEY]: 'nope' } as unknown as Placements)).toBeUndefined();
  });

  it('mergePlacements (the per-breakpoint repair) IGNORES the strip key', () => {
    // The strip key is not a breakpoint, so the page-grid merge never sees it — a
    // blob carrying a strip merges its four breakpoints and drops the reserved key
    // (the component reads/writes the strip via readStrip/withStrip, not merge).
    const def = generateDefaultPlacements(INPUT);
    const saved = withStrip({ lg: def.lg }, strip);
    const merged = mergePlacements(saved, def);
    expect(merged[STRIP_KEY]).toBeUndefined();
    // The four real breakpoints still merge as usual.
    expect(merged.lg!.map((p) => p.i).sort()).toEqual(def.lg!.map((p) => p.i).sort());
  });

  it('placementsEqual detects a strip-card move (so a strip drag persists)', () => {
    const a = withStrip({}, strip);
    const moved = withStrip({}, [{ ...strip[0], x: 6 }, strip[1]]);
    expect(placementsEqual(a, moved)).toBe(false);
    // ...and an identical strip is equal (a no-op gesture won't re-persist).
    expect(placementsEqual(a, withStrip({}, strip))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PIN ANY WIDGET to the top bar (issue #73 polish #4) — pure-side invariants.
// ---------------------------------------------------------------------------
//
// The bar generalized from stats-only to ANY widget. The cross-grid pin/unpin
// MOVE lives in the component (it has registry access), but it rests on these pure
// guarantees: a CHART/PANEL placement round-trips under STRIP_KEY exactly like a
// stat; placementsEqual sees a chart pinned/unpinned (so the PUT fires once and the
// re-feed loop still settles); and findFreeSlot lands a newly-pinned tile on an
// empty strip cell beside the existing pins (the slot the component uses).
describe('top bar holds ANY widget (chart/panel), not just stats', () => {
  it('a chart placement round-trips under STRIP_KEY (readStrip/withStrip)', () => {
    // A chart and the bills panel pinned alongside a stat — the generalized bar.
    const mixed: Placement[] = [
      { i: 'stat:latestBill', x: 0, y: 0, w: 2, h: 3 },
      { i: 'chart:cost', x: 2, y: 0, w: 3, h: 3 },
      { i: 'panel:bills', x: 5, y: 0, w: 3, h: 3 },
    ];
    const blob = withStrip({ lg: [] }, mixed);
    expect(readStrip(blob)).toEqual(mixed);
    // The reserved key is not a breakpoint, so the page merge still ignores it.
    expect(mergePlacements(blob, generateDefaultPlacements(INPUT))[STRIP_KEY]).toBeUndefined();
  });

  it('placementsEqual detects pinning/unpinning a chart in the bar', () => {
    const base = withStrip({}, [{ i: 'stat:latestBill', x: 0, y: 0, w: 2, h: 3 }]);
    const pinnedChart = withStrip({}, [
      { i: 'stat:latestBill', x: 0, y: 0, w: 2, h: 3 },
      { i: 'chart:cost', x: 2, y: 0, w: 3, h: 3 },
    ]);
    // Pinning a chart changes the strip set → a persist fires (PUT).
    expect(placementsEqual(base, pinnedChart)).toBe(false);
    // Unpinning is the inverse — back to base reads as equal (idempotent, no loop).
    expect(placementsEqual(pinnedChart, pinnedChart)).toBe(true);
  });

  it('findFreeSlot lands a pinned tile beside existing strip tiles (no overlap)', () => {
    // The component pins a chart at a compact strip size (w=3, h=3) onto the strip's
    // 12-col grid. With two stat tiles already occupying x=0..3 on row 0, the next
    // free 3-wide cell is x=4 on row 0 — what the pin path places it at.
    const existing: Placement[] = [
      { i: 'stat:a', x: 0, y: 0, w: 2, h: 3 },
      { i: 'stat:b', x: 2, y: 0, w: 2, h: 3 },
    ];
    expect(findFreeSlot(existing, { w: 3, h: 3 }, STRIP_COLS)).toEqual({ x: 4, y: 0 });
  });
});

// ---------------------------------------------------------------------------
// FREE PLACEMENT — the Android-home-screen model (CHANGE 2, issue #73).
// ---------------------------------------------------------------------------
//
// The grid runs with compactType=null + preventCollision in the component, so a
// tile stays exactly where it's dropped and EMPTY CELLS/GAPS between tiles are
// preserved (no upward compaction). The component still runs clampToPages over
// the lg grid to keep a tile from straddling a page boundary, but that pass must
// NOT compact away within-page gaps. These tests fence that contract on the pure
// side: a placement that sits wholly within its page band — INCLUDING one with
// empty rows/columns above or beside it — survives the clamp unchanged, so a
// user-dropped layout round-trips (persist → re-feed → clamp) without re-packing.
describe('clampToPages preserves gaps (free placement, no compaction)', () => {
  it('a tile with empty rows ABOVE it (a vertical gap) is left exactly in place', () => {
    // rpp=14 (a whole page). A tile at y=6 with nothing above it: under vertical
    // compaction this would snap up to y=0; under free placement the gap stays.
    const ps: Placement[] = [{ i: 'chart:cost', x: 3, y: 6, w: 6, h: 7 }];
    expect(clampToPages(ps, 14)).toEqual(ps);
  });

  it('a sparse layout (gaps between AND beside tiles) round-trips byte-identical', () => {
    // A deliberately gappy single-page layout: a tile top-left, one offset to the
    // right with a column gap, one lower with a row gap. None straddles the page
    // (rpp=14), so the clamp is a no-op — every (x, y, w, h) is preserved.
    const sparse: Placement[] = [
      { i: 'chart:usage', x: 0, y: 0, w: 4, h: 4 },
      { i: 'chart:cost', x: 7, y: 1, w: 4, h: 4 }, // column gap (x 4–6 empty)
      { i: 'chart:rates', x: 1, y: 8, w: 5, h: 5 }, // row gap (rows 4–7 empty)
    ];
    const once = clampToPages(sparse, 14);
    expect(once).toEqual(sparse);
    // Idempotent on the gappy layout too (the persist→re-feed loop settles).
    expect(clampToPages(once, 14)).toEqual(once);
  });

  it('only straddlers move; an in-band gap tile beside a straddler keeps its slot', () => {
    // rpp=7. `keep` sits wholly on page 0 with a gap above it; `straddle` crosses
    // the boundary and must re-band to page 1. `keep` must NOT be disturbed.
    const ps: Placement[] = [
      { i: 'keep', x: 0, y: 2, w: 4, h: 4 }, // page 0, rows 2–5 (gap rows 0–1)
      { i: 'straddle', x: 4, y: 5, w: 4, h: 5 }, // rows 5–9 → straddles, → page 1
    ];
    const out = clampToPages(ps, 7);
    expect(out.find((p) => p.i === 'keep')).toEqual(ps[0]); // untouched, gap intact
    expect(out.find((p) => p.i === 'straddle')!.y).toBe(7); // re-banded whole
  });
});

// ---------------------------------------------------------------------------
// findFreeSlot — collision-free drop for "add widget" under free placement.
// ---------------------------------------------------------------------------
//
// With compaction OFF and preventCollision ON, adding a widget can no longer drop
// it at (0,0) and rely on RGL to tuck it in — an overlapping drop would be
// REJECTED. findFreeSlot scans reading-order for the first non-overlapping cell.
describe('findFreeSlot (hand-calculated)', () => {
  it('an empty grid places the tile at the origin', () => {
    expect(findFreeSlot([], { w: 6, h: 7 }, 12)).toEqual({ x: 0, y: 0 });
  });

  it('finds the first empty COLUMN slot on row 0 beside an existing tile', () => {
    // A 6-wide tile at x=0 leaves x=6..11 free on row 0 → a new 6-wide tile fits at x=6.
    const existing: Placement[] = [{ i: 'a', x: 0, y: 0, w: 6, h: 7 }];
    expect(findFreeSlot(existing, { w: 6, h: 7 }, 12)).toEqual({ x: 6, y: 0 });
  });

  it('drops onto the next free ROW when row 0 is full', () => {
    // Row 0 fully occupied by two 6-wide tiles → a new 6-wide tile lands at y=7.
    const existing: Placement[] = [
      { i: 'a', x: 0, y: 0, w: 6, h: 7 },
      { i: 'b', x: 6, y: 0, w: 6, h: 7 },
    ];
    expect(findFreeSlot(existing, { w: 6, h: 7 }, 12)).toEqual({ x: 0, y: 7 });
  });

  it('returns a non-overlapping slot for every existing tile (general property)', () => {
    const existing: Placement[] = [
      { i: 'a', x: 0, y: 0, w: 6, h: 7 },
      { i: 'b', x: 6, y: 0, w: 6, h: 7 },
      { i: 'c', x: 0, y: 7, w: 4, h: 5 },
    ];
    const slot = findFreeSlot(existing, { w: 6, h: 7 }, 12);
    const dropped = { ...slot, w: 6, h: 7 };
    const overlaps = (p: Placement) =>
      dropped.x < p.x + p.w && p.x < dropped.x + 6 && dropped.y < p.y + p.h && p.y < dropped.y + 7;
    expect(existing.some(overlaps)).toBe(false);
  });
});
