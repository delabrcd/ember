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

// Opt-in gating contract (the real regression risk, issue #135 follow-up).
//
// The detector itself is correct but DUMB: given prior>0 & incoming===0 it flags,
// with no idea whether incoming===0 means "upstream broke" or "this caller simply
// didn't fetch that stream". That distinction lives in the IMPURE shell: persist()
// runs the detector ONLY when its caller opts in via `{ detectSanityFloor: true }`,
// and only the full-scrape path (collect() fetched all three streams) opts in. The
// partial-persist callers (intervalPull persists only intervals; pdfFetch always
// persists usage:[]) leave it OFF, so their deliberately-empty streams never trip it.
//
// persist() is impure (DB), so we can't unit-test it hermetically here. What we CAN
// lock is the very input that would mislead the detector if it ran on a partial
// persist: an established account where a partial caller passed all three streams
// empty produces THREE flags. That is exactly the spurious result the opt-in gating
// suppresses — proving WHY persist() must never run the detector on a partial result.
describe('opt-in gating contract (why partial persists must not run the detector)', () => {
  it('an established account with all incoming 0 yields three flags — the spurious result gating prevents', () => {
    // This mirrors what a partial persist (e.g. pdfFetch, which always passes
    // usage:[]) WOULD feed the detector if it ran unconditionally: prior rows exist,
    // incoming is 0 because the caller didn't fetch them — not because upstream broke.
    const flags = detectSanityFloor(
      counts({
        bills: { prior: 27, incoming: 0 },
        usages: { prior: 18, incoming: 0 },
        costs: { prior: 54, incoming: 0 },
      })
    );
    expect(flags.map((f) => f.stream)).toEqual(['bills', 'usages', 'costs']);
    // Because this is a false alarm for a partial fetch, persist() defaults the
    // sanity floor OFF and only the full-scrape path opts in. Partial callers
    // (intervalPull/pdfFetch) call persist(result) with NO option, so the detector
    // never sees these counts and the upsert loops run untouched. The wiring — not
    // the detector — is what keeps these three streams from spuriously flagging.
  });
});
