import { describe, expect, it } from 'vitest';
import {
  COLS,
  DEFAULT_FIT_ROWS,
  PINNED_PAGE_ROWS,
  MIN_ROW_HEIGHT,
  clampToPages,
  computeFitRowHeight,
  computePagedRowHeight,
  computeRowsPerPage,
  generateDefaultPlacements,
  mergePlacements,
  pageCount,
  pageHeightPx,
  paginatePlacements,
  placementRows,
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
    // The runtime two-step (issue #73 iteration): from the available band below
    // the chrome (+ pinned strip), compute how many rows FIT at the nominal
    // height (rowsPerPage, capped at the design budget), then size the row so
    // those rows fill the band exactly. The result is always a sane row (≥ floor)
    // that fills the page → no scroll. We don't FORCE the full budget on a short
    // laptop; rowsPerPage shrinks so a chart row stays readable.
    for (const vh of [768, 800]) {
      const available = vh - 220 - 120 - 44; // chrome + pinned strip + pager allowance
      const fitted = computeRowsPerPage({ available, rowHeight: 40, marginY: 8 });
      const rowsPerPage = Math.max(1, Math.min(fitted, PINNED_PAGE_ROWS));
      const rh = computePagedRowHeight({ available, rowsPerPage, marginY: 8 });
      // A readable row (≥ floor) and the page fills its band exactly.
      expect(rh).toBeGreaterThanOrEqual(MIN_ROW_HEIGHT);
      expect(pageHeightPx({ rowsPerPage, rowHeight: rh, marginY: 8 })).toBeCloseTo(available, 5);
      // At least one chart's worth of rows fit per page (CHART_ROWS = 7), so a
      // page always shows a real chart rather than slivers.
      expect(rowsPerPage).toBeGreaterThanOrEqual(7);
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

  it('lg: charts two-up on the left (8 cols), bills rail on the right (4 cols)', () => {
    const lg = placements.lg!;
    const charts = lg.filter((p) => p.i.startsWith('chart:'));
    // Two columns at x=0 and x=4, each 4 cols wide → an 8-col left block.
    expect(new Set(charts.map((p) => p.x))).toEqual(new Set([0, 4]));
    expect(charts.every((p) => p.w === 4)).toBe(true);
    // The bills rail is the right block: x=8 (12-8), 4 cols wide, and tall enough
    // to span the chart block (stretches the cockpit like today's rail).
    const bills = lg.find((p) => p.i === 'panel:bills')!;
    expect(bills.x).toBe(8);
    expect(bills.w).toBe(4);
    // 7 charts → ceil(7/2)=4 chart rows → the rail spans 4*CHART_ROWS rows.
    expect(bills.h).toBe(4 * 7);
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

  it('the default cockpit occupies DEFAULT_FIT_ROWS rows at lg', () => {
    // Stat band (STAT_ROWS) + two chart rows (2*CHART_ROWS) = DEFAULT_FIT_ROWS.
    // With 7 charts the chart block is 4 rows tall, but the DEFAULT cockpit math
    // (one band + two chart rows) is the per-PAGE target the fit uses; the live
    // count just tracks the real (possibly multi-page) layout.
    const lg = generateDefaultPlacements(INPUT).lg!;
    // A 2-chart layout: stat band (STAT_ROWS) + the bills rail (which spans the
    // 2-row chart-block minimum = 2*CHART_ROWS) = DEFAULT_FIT_ROWS exactly.
    const twoCharts = generateDefaultPlacements({
      statIds: STATS,
      chartIds: ['chart:usage', 'chart:cost'],
      panelIds: PANELS,
    }).lg!;
    expect(placementRows(twoCharts)).toBe(DEFAULT_FIT_ROWS);
    // (sanity: the full set is taller, since 7 charts wrap to 4 rows.)
    expect(placementRows(lg)).toBeGreaterThan(DEFAULT_FIT_ROWS);
  });
});

// ---------------------------------------------------------------------------
// 5. PAGINATION — the phone-home-screen no-scroll fit (issue #73 iteration)
// ---------------------------------------------------------------------------
describe('computeRowsPerPage (hand-calculated)', () => {
  it('floors to whole rows that fit: (available − m)/(rh + m)', () => {
    // available 600, rowHeight 40, margin 8 → (600−8)/(40+8) = 592/48 = 12.33 → 12
    expect(computeRowsPerPage({ available: 600, rowHeight: 40, marginY: 8 })).toBe(12);
  });
  it('clamps to ≥1 so a tiny band still yields one row per page', () => {
    expect(computeRowsPerPage({ available: 10, rowHeight: 40, marginY: 8 })).toBe(1);
  });
  it('floors a row height below the engine floor up to the floor (never divides by ~0)', () => {
    // rowHeight 1 is below MIN_ROW_HEIGHT(24) → treated as 24: (600−8)/(24+8)=18.5→18
    expect(computeRowsPerPage({ available: 600, rowHeight: 1, marginY: 8 })).toBe(18);
  });
});

describe('computePagedRowHeight + pageHeightPx (the per-page no-scroll guarantee)', () => {
  it('sizes a row so rowsPerPage rows EXACTLY fill the band', () => {
    // band 560, 14 rows, margin 8: usable = 560 − 8*15 = 440; rh = 440/14 = 31.43
    const rh = computePagedRowHeight({ available: 560, rowsPerPage: 14, marginY: 8 });
    expect(rh).toBeCloseTo(440 / 14, 5);
    // The page's pixel height == the band (so one page fills the viewport).
    expect(pageHeightPx({ rowsPerPage: 14, rowHeight: rh, marginY: 8 })).toBeCloseTo(560, 5);
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

describe('the default cockpit paginates cleanly at the pinned page budget', () => {
  it('7 charts + bills rail spill to a second page below a pinned stat strip', () => {
    // With the strip pinned, the paged area is PINNED_PAGE_ROWS (= 2 chart rows).
    // The default lg layout's charts+bills (4 chart rows + a 4-row-tall rail)
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
});
