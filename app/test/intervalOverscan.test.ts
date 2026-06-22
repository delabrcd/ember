import { describe, expect, it } from 'vitest';
import {
  overscanWindowFor,
  isViewNearLoadedEdge,
  viewSpanBucketSecs,
  overscanBucketChanged,
  OVERSCAN_MARGIN_FRACTION,
  EXTEND_TRIGGER_FRACTION,
} from '../src/lib/intervalOverscan';
import { chooseBucket } from '../src/lib/viz/chooseBucket';
import { MAX_POINTS } from '../src/lib/viz/downsampleInterval';

// Hand-calculated tests for the PURE WS8 overscan helpers. They decide (1) the wider
// SUPERSET window to LOAD around a visible view, (2) whether the view has panned near
// a loaded edge (→ background extend-load), and (3) the view-span bucket + whether a
// zoom changed it. NO React/DOM/DB — pure number math, worked out by hand below.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

describe('overscan tuning constants', () => {
  it('MARGIN is 1× the view span per side (loaded ≈ 3× view) and triggers at 25%', () => {
    expect(OVERSCAN_MARGIN_FRACTION).toBe(1);
    expect(EXTEND_TRIGGER_FRACTION).toBe(0.25);
  });
});

describe('overscanWindowFor (hand-calculated)', () => {
  it('widens the view by 1× its span on each side (unclamped)', () => {
    // view = [100h, 110h] → span 10h. MARGIN = 1×10h = 10h each side.
    // → loaded = [90h, 120h] (a 30h window, ~3× the view).
    const view = { fromMs: 100 * HOUR, toMs: 110 * HOUR };
    const r = overscanWindowFor(view, 0, 1000 * HOUR);
    expect(r.fromMs).toBe(90 * HOUR);
    expect(r.toMs).toBe(120 * HOUR);
  });

  it('clamps the widened window to the global bounds (no data past the wall)', () => {
    // view = [5h, 15h], span 10h, MARGIN 10h → raw [−5h, 25h]. Bounds [0, 20h] →
    // clamp left to 0, right to 20h.
    const view = { fromMs: 5 * HOUR, toMs: 15 * HOUR };
    const r = overscanWindowFor(view, 0, 20 * HOUR);
    expect(r.fromMs).toBe(0);
    expect(r.toMs).toBe(20 * HOUR);
  });

  it('honors a custom margin fraction', () => {
    // view span 10h, fraction 0.5 → MARGIN 5h each side → [95h, 115h].
    const view = { fromMs: 100 * HOUR, toMs: 110 * HOUR };
    const r = overscanWindowFor(view, 0, 1000 * HOUR, 0.5);
    expect(r.fromMs).toBe(95 * HOUR);
    expect(r.toMs).toBe(115 * HOUR);
  });

  it('leaves the widened window unclamped when bounds are non-finite', () => {
    const view = { fromMs: 100 * HOUR, toMs: 110 * HOUR };
    const r = overscanWindowFor(view, NaN, NaN);
    expect(r.fromMs).toBe(90 * HOUR);
    expect(r.toMs).toBe(120 * HOUR);
  });

  it('orders an inverted view before widening', () => {
    // Inverted input → ordered first to [100h, 110h], span 10h, MARGIN 10h → [90h, 120h].
    const r = overscanWindowFor({ fromMs: 110 * HOUR, toMs: 100 * HOUR }, 0, 1000 * HOUR);
    expect(r.fromMs).toBe(90 * HOUR);
    expect(r.toMs).toBe(120 * HOUR);
  });

  it('degrades a zero-span view to itself (margin 0)', () => {
    // Equal endpoints → span 0 → margin 0 → the point itself (no widening).
    const r = overscanWindowFor({ fromMs: 100 * HOUR, toMs: 100 * HOUR }, 0, 1000 * HOUR);
    expect(r.fromMs).toBe(100 * HOUR);
    expect(r.toMs).toBe(100 * HOUR);
  });
});

describe('isViewNearLoadedEdge (hand-calculated)', () => {
  // A loaded superset of [0, 30h] for a view span of 10h. MARGIN = 10h, threshold =
  // 0.25 × 10h = 2.5h. Bounds well outside so neither edge is "at the wall".
  const bounds = { from: -1000 * HOUR, to: 1000 * HOUR };
  const loaded = { fromMs: 0, toMs: 30 * HOUR };

  it('is FALSE when the view sits comfortably inside the superset', () => {
    // view [10h,20h] (span 10h, centered): left gap = 10h, right gap = 10h, both ≫ 2.5h.
    const view = { fromMs: 10 * HOUR, toMs: 20 * HOUR };
    expect(isViewNearLoadedEdge(view, loaded, bounds.from, bounds.to)).toBe(false);
  });

  it('is TRUE when the view approaches the LEFT loaded edge (within 25% of MARGIN)', () => {
    // view [2h,12h] (span 10h): left gap = 2h ≤ 2.5h threshold → near left.
    const view = { fromMs: 2 * HOUR, toMs: 12 * HOUR };
    expect(isViewNearLoadedEdge(view, loaded, bounds.from, bounds.to)).toBe(true);
  });

  it('is TRUE when the view approaches the RIGHT loaded edge', () => {
    // view [18h,28h] (span 10h): right gap = 30h − 28h = 2h ≤ 2.5h → near right.
    const view = { fromMs: 18 * HOUR, toMs: 28 * HOUR };
    expect(isViewNearLoadedEdge(view, loaded, bounds.from, bounds.to)).toBe(true);
  });

  it('is FALSE at a loaded edge that is ALREADY pinned to the global wall (nothing to gain)', () => {
    // loaded.from = 0 is the LEFT bound; even with the view jammed against it there's
    // no earlier data to load, so no extend should fire on the left.
    const view = { fromMs: 0, toMs: 10 * HOUR };
    const r = isViewNearLoadedEdge(view, { fromMs: 0, toMs: 30 * HOUR }, 0, 1000 * HOUR);
    expect(r).toBe(false); // left at wall, right gap = 20h ≫ threshold → no extend
  });

  it('is FALSE for a degenerate (zero-span) view', () => {
    const view = { fromMs: 10 * HOUR, toMs: 10 * HOUR };
    expect(isViewNearLoadedEdge(view, loaded, bounds.from, bounds.to)).toBe(false);
  });
});

describe('viewSpanBucketSecs + overscanBucketChanged (hand-calculated)', () => {
  it('derives the bucket from the VIEW span (matches chooseBucket on that span)', () => {
    // A 2-day view → chooseBucket(2 days). Compute both ways; they must agree (the
    // helper must NOT use a wider span).
    const view = { fromMs: 0, toMs: 2 * DAY };
    const expected = chooseBucket(2 * DAY, MAX_POINTS);
    expect(viewSpanBucketSecs(view, MAX_POINTS)).toBe(expected);
  });

  it('a narrow (≤ ~6 day) view resolves to the 900s (15-min) grid bucket', () => {
    // 2 days = 192 fifteen-min slots ≤ 600 → chooseBucket picks 900.
    expect(viewSpanBucketSecs({ fromMs: 0, toMs: 2 * DAY }, MAX_POINTS)).toBe(900);
  });

  it('a wide (multi-month) view resolves to a coarser bucket than 900', () => {
    const wide = viewSpanBucketSecs({ fromMs: 0, toMs: 120 * DAY }, MAX_POINTS);
    expect(wide).toBeGreaterThan(900);
  });

  it('overscanBucketChanged is TRUE when nothing is loaded yet (forces the first load)', () => {
    expect(overscanBucketChanged({ fromMs: 0, toMs: 2 * DAY }, null, MAX_POINTS)).toBe(true);
    expect(overscanBucketChanged({ fromMs: 0, toMs: 2 * DAY }, undefined, MAX_POINTS)).toBe(true);
  });

  it('overscanBucketChanged is FALSE when the loaded bucket already matches the view grain', () => {
    // A 2-day view → 900; loaded at 900 → unchanged (a same-grain pan reuses the superset).
    expect(overscanBucketChanged({ fromMs: 0, toMs: 2 * DAY }, 900, MAX_POINTS)).toBe(false);
  });

  it('overscanBucketChanged is TRUE when a ZOOM changed the view grain', () => {
    // A wide view loaded coarse, then zoomed to a 2-day view (→ 900) ≠ the coarse
    // loaded bucket → reload at the finer grain.
    const coarse = viewSpanBucketSecs({ fromMs: 0, toMs: 120 * DAY }, MAX_POINTS);
    expect(overscanBucketChanged({ fromMs: 0, toMs: 2 * DAY }, coarse, MAX_POINTS)).toBe(true);
  });
});
