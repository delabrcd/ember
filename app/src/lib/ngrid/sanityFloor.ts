// Pure scrape sanity-floor detector (issue #135).
//
// collect.ts keys extraction on exact upstream GraphQL response shapes. If
// National Grid renames or restructures a field, that stream comes back EMPTY,
// the scrape records zero rows for it, and reports SUCCESS — indistinguishable
// from a genuinely bill-less account. That is a silent data-accuracy failure the
// hermetic unit suite structurally cannot catch (no live portal in CI).
//
// This module is the PURE detector: given, per stream, how many rows the account
// already HAD (`prior`) and how many this scrape returned (`incoming`), it
// reports the streams that look like an upstream-shape break. It is CONSERVATIVE:
// it flags ONLY the unambiguous case where an established stream went to zero
// (prior > 0 && incoming === 0). A genuinely new/empty account (prior === 0)
// never trips it, and a stream that merely returned FEWER rows (incoming > 0) is
// out of scope — a partial field rename yielding malformed individual rows is a
// different failure mode the impure shell does not gate on (see issue #135).
//
// PURE: no DB / browser / network / React import. The impure shell (persist.ts)
// counts the prior rows, runs this, then uses the result to skip the empty
// stream's upsert loop (preserving existing rows) and surface the flag.

// The data streams we guard. Each maps 1:1 to a collect.ts result array and a
// persist.ts upsert loop.
export type SanityStream = 'bills' | 'usages' | 'costs';

// Per-stream row counts going into the detector.
export interface StreamCounts {
  prior: number; // rows this account already had for the stream (pre-upsert)
  incoming: number; // rows this scrape returned for the stream
}

// A flagged stream: the established stream went empty this scrape.
export interface SanityFlag {
  stream: SanityStream;
  prior: number;
  // Human-readable reason, e.g. "had 27 bills, scrape returned 0".
  reason: string;
}

// Detect suspect streams. `counts` is the per-stream {prior, incoming}. Returns
// one SanityFlag per stream that had rows before and returned none now, in a
// stable stream order (bills, usages, costs). An empty array means nothing is
// suspect (the common, healthy case).
export function detectSanityFloor(
  counts: Record<SanityStream, StreamCounts>
): SanityFlag[] {
  const order: SanityStream[] = ['bills', 'usages', 'costs'];
  const flags: SanityFlag[] = [];
  for (const stream of order) {
    const { prior, incoming } = counts[stream];
    // Conservative gate: only an ESTABLISHED stream (prior > 0) that returned
    // EXACTLY zero rows is suspect. prior === 0 (new account) or incoming > 0
    // (some data, possibly partial — out of scope) is never flagged.
    if (prior > 0 && incoming === 0) {
      flags.push({
        stream,
        prior,
        reason: `had ${prior} ${stream}, scrape returned 0`,
      });
    }
  }
  return flags;
}
