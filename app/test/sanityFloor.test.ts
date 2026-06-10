import { describe, expect, it } from 'vitest';
import { detectSanityFloor, type SanityStream, type StreamCounts } from '../src/lib/ngrid/sanityFloor';

// Convenience builder: default every stream to {prior:0, incoming:0} (a clean new
// account) and override only the streams a case exercises, so each test states
// exactly the numbers it reasons about.
function counts(overrides: Partial<Record<SanityStream, StreamCounts>>): Record<SanityStream, StreamCounts> {
  return {
    bills: { prior: 0, incoming: 0 },
    usages: { prior: 0, incoming: 0 },
    costs: { prior: 0, incoming: 0 },
    ...overrides,
  };
}

describe('detectSanityFloor (hand-calculated)', () => {
  it('had-N-now-0 flags the stream (the issue #135 failure)', () => {
    // bills: had 27, scrape returned 0 → upstream shape break. Flag it.
    const flags = detectSanityFloor(counts({ bills: { prior: 27, incoming: 0 } }));
    expect(flags).toHaveLength(1);
    expect(flags[0].stream).toBe('bills');
    expect(flags[0].prior).toBe(27);
    expect(flags[0].reason).toBe('had 27 bills, scrape returned 0');
  });

  it('new account prior-0-now-0 raises NO false alarm', () => {
    // A genuinely bill-less account: nothing before, nothing now, on every stream.
    expect(detectSanityFloor(counts({}))).toEqual([]);
  });

  it('had-N-now-M (M>0) is healthy — not flagged', () => {
    // usages had 18, scrape returned 18 (or any M>0). Data present → not suspect.
    expect(detectSanityFloor(counts({ usages: { prior: 18, incoming: 18 } }))).toEqual([]);
    // Even a DROP to fewer-but-nonzero rows is out of scope (partial rename).
    expect(detectSanityFloor(counts({ usages: { prior: 18, incoming: 3 } }))).toEqual([]);
  });

  it('first scrape of a new account (prior 0, incoming N) is healthy', () => {
    // A fresh account that just got its first 12 bills/usages/costs — must not flag.
    const flags = detectSanityFloor(
      counts({
        bills: { prior: 0, incoming: 12 },
        usages: { prior: 0, incoming: 24 },
        costs: { prior: 0, incoming: 48 },
      })
    );
    expect(flags).toEqual([]);
  });

  it('flags multiple streams independently, in stable order', () => {
    // bills and costs both went established→0; usages stayed healthy. The two
    // flags come back in the fixed order bills, costs.
    const flags = detectSanityFloor(
      counts({
        bills: { prior: 27, incoming: 0 },
        usages: { prior: 18, incoming: 18 },
        costs: { prior: 54, incoming: 0 },
      })
    );
    expect(flags).toHaveLength(2);
    expect(flags.map((f) => f.stream)).toEqual(['bills', 'costs']);
    expect(flags[0].reason).toBe('had 27 bills, scrape returned 0');
    expect(flags[1].reason).toBe('had 54 costs, scrape returned 0');
  });

  it('flags all three when an entire scrape comes back empty for an established account', () => {
    const flags = detectSanityFloor(
      counts({
        bills: { prior: 5, incoming: 0 },
        usages: { prior: 10, incoming: 0 },
        costs: { prior: 20, incoming: 0 },
      })
    );
    expect(flags.map((f) => f.stream)).toEqual(['bills', 'usages', 'costs']);
  });
});
