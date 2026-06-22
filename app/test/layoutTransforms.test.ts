import { describe, expect, it } from 'vitest';
import {
  addSpacer,
  addToPlacements,
  buildPersistBlob,
  clampToPagesSafe,
  foldSpacerDefaults,
  removeFromPlacements,
  repairStrip,
  togglePin,
  STRIP_KEY,
  type Placement,
  type Placements,
} from '../src/lib/layoutEngine';

// Hand-calculated tests for the pure placement transforms LIFTED out of
// Dashboard.tsx / WidgetLayout.tsx into lib/layout/transforms.ts (issue #157, §2).
// These were previously inline component logic; the tests fence the behaviour that
// the move must preserve byte-identically (the keep-known / append-new /
// drop-unknown semantics, the persisted JSON shape, the pin/unpin round-trip).

const FIT = 'lg' as const;
// A registry box prototype (mirrors a chart's defaultSize).
const CHART_BOX = { w: 6, h: 7, minW: 3, minH: 2 };
const SPACER_BOX = { w: 3, h: 2, minW: 1, minH: 1 };

// ---------------------------------------------------------------------------
// removeFromPlacements
// ---------------------------------------------------------------------------
describe('removeFromPlacements (hand-calculated)', () => {
  it('no saved layout → materializes the supplied lg default MINUS the type', () => {
    const lgDefault: Placement[] = [
      { i: 'chart:a', x: 0, y: 0, w: 6, h: 7 },
      { i: 'chart:b', x: 6, y: 0, w: 6, h: 7 },
    ];
    const out = removeFromPlacements(undefined, 'chart:a', lgDefault, FIT);
    // Only lg is materialized; chart:a is gone, chart:b survives.
    expect(out.lg).toEqual([{ i: 'chart:b', x: 6, y: 0, w: 6, h: 7 }]);
    expect(out.md).toBeUndefined();
  });

  it('strips the type from EVERY saved breakpoint, keeping the rest verbatim', () => {
    const cur: Placements = {
      lg: [
        { i: 'chart:a', x: 0, y: 0, w: 6, h: 7 },
        { i: 'chart:b', x: 6, y: 0, w: 6, h: 7 },
      ],
      md: [{ i: 'chart:a', x: 0, y: 0, w: 4, h: 7 }],
    };
    const out = removeFromPlacements(cur, 'chart:a', [], FIT);
    expect(out.lg).toEqual([{ i: 'chart:b', x: 6, y: 0, w: 6, h: 7 }]);
    expect(out.md).toEqual([]);
  });

  it('does NOT carry the strip key (only real breakpoints are iterated)', () => {
    const cur: Placements = {
      lg: [{ i: 'chart:a', x: 0, y: 0, w: 6, h: 7 }],
      [STRIP_KEY]: [{ i: 'stat:x', x: 0, y: 0, w: 3, h: 2 }],
    };
    const out = removeFromPlacements(cur, 'chart:a', [], FIT);
    // The original removeFromPlacements iterated Object.keys(cur), which INCLUDES
    // the strip key — so the strip rides through (filtered for the type too).
    expect(out[STRIP_KEY]).toEqual([{ i: 'stat:x', x: 0, y: 0, w: 3, h: 2 }]);
  });
});

// ---------------------------------------------------------------------------
// addToPlacements
// ---------------------------------------------------------------------------
describe('addToPlacements (hand-calculated)', () => {
  it('null cur → returns null (nothing removed yet, already shown)', () => {
    expect(addToPlacements(undefined, 'chart:a', CHART_BOX, FIT)).toBeNull();
  });

  it('type already placed at lg → returns null (no change)', () => {
    const cur: Placements = { lg: [{ i: 'chart:a', x: 0, y: 0, w: 6, h: 7 }] };
    expect(addToPlacements(cur, 'chart:a', CHART_BOX, FIT)).toBeNull();
  });

  it('adds at the first free lg slot, prepended, carrying min stamps', () => {
    // lg has one 6-wide tile at x=0 → the next free 6-wide cell is x=6, y=0.
    const cur: Placements = { lg: [{ i: 'chart:a', x: 0, y: 0, w: 6, h: 7 }], md: [{ i: 'chart:a', x: 0, y: 0, w: 4, h: 7 }] };
    const out = addToPlacements(cur, 'chart:b', CHART_BOX, FIT)!;
    expect(out.lg![0]).toEqual({ i: 'chart:b', x: 6, y: 0, w: 6, h: 7, minW: 3, minH: 2 });
    expect(out.lg![1]).toEqual({ i: 'chart:a', x: 0, y: 0, w: 6, h: 7 });
    // Other breakpoints pass through unchanged (merge defaults pick the new one up).
    expect(out.md).toEqual(cur.md);
  });
});

// ---------------------------------------------------------------------------
// addSpacer
// ---------------------------------------------------------------------------
describe('addSpacer (hand-calculated)', () => {
  it('no saved layout → drops the spacer onto the materialized lg base', () => {
    const lgBase: Placement[] = [{ i: 'chart:a', x: 0, y: 0, w: 12, h: 7 }];
    const out = addSpacer(undefined, 'spacer:1', SPACER_BOX, lgBase, FIT);
    // Row 0 full (12 wide) → the 3-wide spacer lands at the next row y=7.
    expect(out.lg![0]).toEqual({ i: 'spacer:1', x: 0, y: 7, w: 3, h: 2, minW: 1, minH: 1 });
    expect(out.lg![1]).toEqual({ i: 'chart:a', x: 0, y: 0, w: 12, h: 7 });
  });

  it('preserves other saved breakpoints + the strip; only lg gains the spacer', () => {
    const cur: Placements = {
      lg: [{ i: 'chart:a', x: 0, y: 0, w: 6, h: 7 }],
      md: [{ i: 'chart:a', x: 0, y: 0, w: 4, h: 7 }],
      [STRIP_KEY]: [{ i: 'stat:x', x: 0, y: 0, w: 3, h: 2 }],
    };
    const out = addSpacer(cur, 'spacer:2', SPACER_BOX, [], FIT);
    // lg gains the spacer at its first free slot (x=6, y=0 beside the 6-wide chart).
    expect(out.lg![0]).toEqual({ i: 'spacer:2', x: 6, y: 0, w: 3, h: 2, minW: 1, minH: 1 });
    expect(out.md).toEqual(cur.md);
    // The strip rides through untouched.
    expect(out[STRIP_KEY]).toEqual(cur[STRIP_KEY]);
  });
});

// ---------------------------------------------------------------------------
// togglePin
// ---------------------------------------------------------------------------
describe('togglePin (hand-calculated)', () => {
  const fullDefault: Placements = {
    lg: [{ i: 'chart:a', x: 0, y: 0, w: 6, h: 7 }, { i: 'stat:x', x: 6, y: 0, w: 2, h: 2 }],
    md: [{ i: 'chart:a', x: 0, y: 0, w: 4, h: 7 }, { i: 'stat:x', x: 4, y: 0, w: 2, h: 2 }],
    sm: [{ i: 'chart:a', x: 0, y: 0, w: 3, h: 7 }, { i: 'stat:x', x: 3, y: 0, w: 2, h: 2 }],
    xs: [{ i: 'chart:a', x: 0, y: 0, w: 2, h: 7 }, { i: 'stat:x', x: 0, y: 7, w: 1, h: 2 }],
  };

  it('PIN: adds the widget to the strip at a free slot + drops it from every page bp', () => {
    const out = togglePin(undefined, 'chart:a', {
      curStrip: [{ i: 'stat:x', x: 0, y: 0, w: 3, h: 2 }],
      fullDefault,
      defaultSize: CHART_BOX,
      stripSize: { w: 3, h: 2 },
      stripCols: 24,
    });
    const strip = out[STRIP_KEY]!;
    // Strip now holds the existing stat + the newly-pinned chart at a free slot (x=3).
    expect(strip).toContainEqual({ i: 'chart:a', x: 3, y: 0, w: 3, h: 2, minW: 3, minH: 2 });
    expect(strip).toContainEqual({ i: 'stat:x', x: 0, y: 0, w: 3, h: 2 });
    // chart:a is dropped from EVERY page breakpoint (lives only in the bar).
    for (const bp of ['lg', 'md', 'sm', 'xs'] as const) {
      expect(out[bp]!.some((p) => p.i === 'chart:a')).toBe(false);
      expect(out[bp]!.some((p) => p.i === 'stat:x')).toBe(true);
    }
  });

  it('UNPIN: removes from the strip + re-adds a page slot at each breakpoint', () => {
    // chart:a is currently pinned (in the strip), missing from the page blob.
    const cur: Placements = {
      lg: [{ i: 'stat:x', x: 6, y: 0, w: 2, h: 2 }],
      md: [{ i: 'stat:x', x: 4, y: 0, w: 2, h: 2 }],
      sm: [{ i: 'stat:x', x: 3, y: 0, w: 2, h: 2 }],
      xs: [{ i: 'stat:x', x: 0, y: 7, w: 1, h: 2 }],
      [STRIP_KEY]: [{ i: 'stat:x', x: 0, y: 0, w: 3, h: 2 }, { i: 'chart:a', x: 3, y: 0, w: 3, h: 2 }],
    };
    const out = togglePin(cur, 'chart:a', {
      curStrip: cur[STRIP_KEY]!,
      fullDefault,
      defaultSize: CHART_BOX,
      stripSize: { w: 3, h: 2 },
      stripCols: 24,
    });
    // Strip no longer holds chart:a.
    expect(out[STRIP_KEY]!.some((p) => p.i === 'chart:a')).toBe(false);
    // Every page breakpoint regains a chart:a tile (width clamped to the bp cols).
    for (const bp of ['lg', 'md', 'sm', 'xs'] as const) {
      const a = out[bp]!.find((p) => p.i === 'chart:a');
      expect(a, bp).toBeDefined();
    }
    // At xs (2 cols) the re-added chart width is clamped to 2.
    expect(out.xs!.find((p) => p.i === 'chart:a')!.w).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// clampToPagesSafe
// ---------------------------------------------------------------------------
describe('clampToPagesSafe (hand-calculated)', () => {
  it('no-ops on an empty grid (returns the same array)', () => {
    const empty: Placement[] = [];
    expect(clampToPagesSafe(empty, 7)).toBe(empty);
  });
  it('clamps + flattens a non-empty grid (a straddler is re-banded)', () => {
    const out = clampToPagesSafe([{ i: 'a', x: 0, y: 4, w: 4, h: 7 }], 7);
    expect(out[0]).toMatchObject({ i: 'a', y: 7, h: 7 });
  });
});

// ---------------------------------------------------------------------------
// foldSpacerDefaults
// ---------------------------------------------------------------------------
describe('foldSpacerDefaults (hand-calculated)', () => {
  const base: Placements = {
    lg: [{ i: 'chart:a', x: 0, y: 0, w: 12, h: 7 }],
    md: [{ i: 'chart:a', x: 0, y: 0, w: 8, h: 7 }],
    sm: [{ i: 'chart:a', x: 0, y: 0, w: 6, h: 7 }],
    xs: [{ i: 'chart:a', x: 0, y: 0, w: 2, h: 7 }],
  };

  it('no spacers → returns base unchanged (identity)', () => {
    expect(foldSpacerDefaults(base, [], undefined, SPACER_BOX)).toBe(base);
  });

  it('folds a spacer with SAVED geometry (authoritative) into every breakpoint', () => {
    const saved: Placements = {
      lg: [{ i: 'spacer:1', x: 4, y: 9, w: 5, h: 3 }],
    };
    const out = foldSpacerDefaults(base, ['spacer:1'], saved, SPACER_BOX);
    // lg uses the saved geometry verbatim, re-stamping the prototype mins.
    const lgSpacer = out.lg!.find((p) => p.i === 'spacer:1')!;
    expect(lgSpacer).toEqual({ i: 'spacer:1', x: 4, y: 9, w: 5, h: 3, minW: 1, minH: 1 });
    // md/sm/xs (no saved spacer) get a free-slot fallback at the prototype size,
    // width clamped to the breakpoint cols (xs=2 → min(3,2)=2).
    expect(out.xs!.find((p) => p.i === 'spacer:1')!.w).toBe(2);
    expect(out.md!.some((p) => p.i === 'spacer:1')).toBe(true);
  });

  it('a spacer with NO saved geometry gets a free slot at the prototype size', () => {
    const out = foldSpacerDefaults(base, ['spacer:1'], undefined, SPACER_BOX);
    // lg row 0 is full (12 wide) → the 3-wide spacer falls to y=7.
    expect(out.lg!.find((p) => p.i === 'spacer:1')).toEqual({
      i: 'spacer:1',
      x: 0,
      y: 7,
      w: 3,
      h: 2,
      minW: 1,
      minH: 1,
    });
  });
});

// ---------------------------------------------------------------------------
// repairStrip
// ---------------------------------------------------------------------------
describe('repairStrip (hand-calculated)', () => {
  const boxOf = (id: string) => (id.startsWith('chart:') ? CHART_BOX : { w: 3, h: 2, minW: 1, minH: 2 });

  it('drops a pin whose widget is no longer placed (a removed widget)', () => {
    const source: Placement[] = [
      { i: 'stat:x', x: 0, y: 0, w: 3, h: 2 },
      { i: 'chart:gone', x: 3, y: 0, w: 3, h: 2 },
    ];
    const out = repairStrip(source, ['stat:x'], boxOf);
    expect(out.map((p) => p.i)).toEqual(['stat:x']);
  });

  it('stamps + lifts each kept tile to its registry min floor (self-heal)', () => {
    // A crushed chart pin (w=1, below minW=3) self-heals up to the floor.
    const source: Placement[] = [{ i: 'chart:a', x: 0, y: 0, w: 1, h: 1 }];
    const out = repairStrip(source, ['chart:a'], boxOf);
    expect(out[0]).toEqual({ i: 'chart:a', x: 0, y: 0, w: 3, h: 2, minW: 3, minH: 2 });
  });

  it('leaves an already-conforming tile at its (larger) size, only stamping mins', () => {
    const source: Placement[] = [{ i: 'chart:a', x: 2, y: 0, w: 5, h: 4 }];
    const out = repairStrip(source, ['chart:a'], boxOf);
    expect(out[0]).toEqual({ i: 'chart:a', x: 2, y: 0, w: 5, h: 4, minW: 3, minH: 2 });
  });
});

// ---------------------------------------------------------------------------
// buildPersistBlob
// ---------------------------------------------------------------------------
describe('buildPersistBlob (hand-calculated)', () => {
  it('passes non-fit breakpoints through sanitized, and persists the strip', () => {
    const sanitizedByBp = {
      lg: [{ i: 'chart:a', x: 0, y: 0, w: 6, h: 7 }] as Placement[],
      md: [{ i: 'chart:a', x: 0, y: 0, w: 4, h: 7 }] as Placement[],
    };
    const out = buildPersistBlob({
      sanitizedByBp,
      layouts: {},
      pinnedIds: new Set<string>(),
      gridIds: ['chart:a'],
      rowsPerPage: 14,
      fitBp: 'lg',
      pinActive: false,
      fitActive: false,
      savedStrip: [{ i: 'stat:x', x: 0, y: 0, w: 3, h: 2 }],
    });
    expect(out.md).toEqual(sanitizedByBp.md);
    expect(out[STRIP_KEY]).toEqual([{ i: 'stat:x', x: 0, y: 0, w: 3, h: 2 }]);
  });

  it('folds the pinned tiles back into the lg blob (so unpin keeps their geometry)', () => {
    // The grid excluded the pinned chart:p; its saved page geometry lives in
    // `layouts.lg` and must be folded back into the persisted lg blob.
    const out = buildPersistBlob({
      sanitizedByBp: { lg: [{ i: 'chart:a', x: 0, y: 0, w: 6, h: 7 }] },
      layouts: { lg: [{ i: 'chart:p', x: 6, y: 0, w: 6, h: 7 }, { i: 'chart:a', x: 0, y: 0, w: 6, h: 7 }] },
      pinnedIds: new Set(['chart:p']),
      gridIds: ['chart:a'],
      rowsPerPage: 14,
      fitBp: 'lg',
      pinActive: true,
      fitActive: true,
      savedStrip: undefined,
    });
    // The pinned chart:p is prepended back; chart:a stays.
    expect(out.lg!.some((p) => p.i === 'chart:p')).toBe(true);
    expect(out.lg!.some((p) => p.i === 'chart:a')).toBe(true);
    // No strip key when savedStrip is undefined.
    expect(out[STRIP_KEY]).toBeUndefined();
  });

  it('clamps the paged (lg, fit) grid so a straddler is re-banded', () => {
    // rowsPerPage=7; chart:a at y=4 h=7 straddles rows 4-10 → re-banded to y=7.
    const out = buildPersistBlob({
      sanitizedByBp: { lg: [{ i: 'chart:a', x: 0, y: 4, w: 6, h: 7 }] },
      layouts: {},
      pinnedIds: new Set<string>(),
      gridIds: ['chart:a'],
      rowsPerPage: 7,
      fitBp: 'lg',
      pinActive: false,
      fitActive: true,
      savedStrip: undefined,
    });
    expect(out.lg!.find((p) => p.i === 'chart:a')).toMatchObject({ y: 7, h: 7 });
  });
});
