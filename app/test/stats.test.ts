import { describe, expect, it } from 'vitest';
import { mad, median, populationStd, sampleStdev } from '../src/lib/stats';

// Every expected value below is worked out BY HAND in the comment, per
// standards §1 — not a snapshot of what the code happens to return.

describe('median (hand-calculated)', () => {
  it('odd length → the middle element of the sorted copy', () => {
    // [3,1,2] → sorted [1,2,3], mid = floor(3/2) = 1 → 2.
    expect(median([3, 1, 2])).toBe(2);
  });

  it('even length → the mean of the two central elements', () => {
    // [4,1,3,2] → sorted [1,2,3,4], mid = 2 → (s[1]+s[2])/2 = (2+3)/2 = 2.5.
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('single element returns itself', () => {
    expect(median([7])).toBe(7);
  });

  it('handles negatives', () => {
    // [-5,-1,-3] → sorted [-5,-3,-1], mid = 1 → -3.
    expect(median([-5, -1, -3])).toBe(-3);
  });

  it('does not mutate its input', () => {
    const xs = [3, 1, 2];
    median(xs);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('mad (median absolute deviation, hand-calculated)', () => {
  it('even-length list', () => {
    // [1,2,4,7]: median = (2+4)/2 = 3.
    // abs devs = [2,1,1,4] → sorted [1,1,2,4], median = (1+2)/2 = 1.5.
    expect(mad([1, 2, 4, 7])).toBe(1.5);
  });

  it('odd-length list', () => {
    // [1,2,9]: median = 2. abs devs = [1,0,7] → sorted [0,1,7], median = 1.
    expect(mad([1, 2, 9])).toBe(1);
  });

  it('flat list → 0 spread', () => {
    // [5,5,5]: median 5, devs [0,0,0], median 0.
    expect(mad([5, 5, 5])).toBe(0);
  });
});

describe('sampleStdev (n-1, hand-calculated)', () => {
  it('three values', () => {
    // [2,4,6]: mean 4, sq devs [4,0,4] sum 8, var = 8/(3-1) = 4, sqrt = 2.
    expect(sampleStdev([2, 4, 6])).toBe(2);
  });

  it('four values', () => {
    // [10,12,14,16]: mean 13, sq devs [9,1,1,9] sum 20, var = 20/3 = 6.6667,
    // sqrt = 2.5819888974716...
    expect(sampleStdev([10, 12, 14, 16])!).toBeCloseTo(2.581988897471611, 12);
  });

  it('fewer than two values → null (no estimable spread)', () => {
    expect(sampleStdev([5])).toBeNull();
    expect(sampleStdev([])).toBeNull();
  });
});

describe('populationStd (n, hand-calculated)', () => {
  it('three values, mean computed internally', () => {
    // [2,4,6]: mean 4, sq devs sum 8, var = 8/3 = 2.6667, sqrt = 1.632993...
    expect(populationStd([2, 4, 6])).toBeCloseTo(1.632993161855452, 12);
  });

  it('four values', () => {
    // [10,12,14,16]: mean 13, sq devs sum 20, var = 20/4 = 5, sqrt = 2.2360679...
    expect(populationStd([10, 12, 14, 16])).toBeCloseTo(2.23606797749979, 12);
  });

  it('accepts a precomputed mean (same result as computing it)', () => {
    // mean of [2,4,6] is exactly 4 → identical to the internal-mean path.
    expect(populationStd([2, 4, 6], 4)).toBe(populationStd([2, 4, 6]));
  });

  it('fewer than two values → 0', () => {
    expect(populationStd([5])).toBe(0);
    expect(populationStd([])).toBe(0);
  });
});

describe('the n vs n-1 distinction is preserved', () => {
  it('sampleStdev (n-1) > populationStd (n) on the same data', () => {
    // [2,4,6]: sample = sqrt(8/2) = 2; population = sqrt(8/3) = 1.6330.
    expect(sampleStdev([2, 4, 6])).toBe(2);
    expect(populationStd([2, 4, 6])).toBeCloseTo(1.632993161855452, 12);
    expect(sampleStdev([2, 4, 6])!).toBeGreaterThan(populationStd([2, 4, 6]));
  });
});
