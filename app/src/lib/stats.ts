// Tiny shared statistics primitives (issue #151).
//
// These were reimplemented inline in several pure libs (prediction.ts twice,
// anomaly.ts, viz/aggregate.ts). Factored out here, behavior-preserving, so the
// median tie-break and the n vs n−1 distinction live in ONE hand-tested place.
//
// PURE + HERMETIC: no DB, no React, no I/O — the Docker test stage has neither a
// database nor a browser, and these must be importable from any pure module.
// Hand-calculated tests in test/stats.test.ts.

// Median of a numeric list. Sorts a COPY (never mutates the input) ascending;
// for an odd length returns the middle element, for an even length the mean of
// the two central elements. The caller guarantees a non-empty list — an empty
// list yields NaN (mid is undefined), matching the previous inline behavior.
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Median Absolute Deviation about the median — a robust spread measure. 0 for a
// flat list. (Raw MAD, NOT scaled by the 1.4826 normal-consistency factor; the
// caller applies that scale where it wants a stdev-equivalent.)
export function mad(xs: number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

// SAMPLE standard deviation (divide by n−1, Bessel's correction): an inferential
// estimate of the population spread from a sample. Returns null for fewer than
// two values (a single sample has no estimable spread). Distinct from
// populationStd — keep the distinction.
export function sampleStdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

// POPULATION standard deviation (divide by n): a DESCRIPTIVE spread of the
// observed values themselves, not an inferential estimate, so n is the right
// denominator. Returns 0 for fewer than two values. The mean may be passed in
// when the caller already computed it (avoids a second pass); otherwise it is
// computed here. Distinct from sampleStdev — keep the distinction.
export function populationStd(xs: number[], mean?: number): number {
  if (xs.length < 2) return 0;
  const mu = mean ?? xs.reduce((a, b) => a + b, 0) / xs.length;
  let acc = 0;
  for (const x of xs) acc += (x - mu) * (x - mu);
  return Math.sqrt(acc / xs.length);
}
