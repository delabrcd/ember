// Pure, hermetic cross-process single-flight decision (issue #136).
//
// Single-flight — never two concurrent National Grid logins (good-guest,
// standards §4) — is enforced in-process by a module-level `inFlight` lock in
// progress.ts. That is only sound while `next start` is a single Node process;
// a second replica / worker would each pass the in-memory check and log in
// concurrently. This module is the PURE half of the cross-process guard: given
// the current time, the most-recent RUNNING ScrapeRun's start time (the durable
// cross-process flag), and a staleness window, it decides whether a new claimer
// may CLAIM the slot or must back off as BUSY.
//
// The impure half (progress.ts) takes a Postgres transaction-scoped advisory
// lock to serialize concurrent claimers, reads the latest RUNNING row, calls
// decideScrapeClaim(), and — if CLAIM — creates the new RUNNING row inside the
// same transaction so the read+claim is atomic. No DB/browser import here so the
// decision is unit-testable with hand-calculated cases (the Docker test stage has
// no DB).

// Fixed app-wide bigint key for pg_advisory_xact_lock. Hand-chosen constant,
// unique to this guard within the app (there is only one advisory lock in Ember).
// A transaction-scoped advisory lock auto-releases at COMMIT/ROLLBACK and on
// connection close, so it can never deadlock a crashed claimer.
export const SCRAPE_CLAIM_ADVISORY_KEY = 728142;

// How long a RUNNING ScrapeRun row stays authoritative before it's treated as a
// crashed/abandoned run that should no longer block new ticks. Picked slightly
// above the scrape route's maxDuration (300s) so a healthy in-progress run is
// never mistaken for stale, while a process that died mid-scrape (and so never
// finalized its row to SUCCESS/ERROR) stops blocking after this window.
export const SCRAPE_STALE_AFTER_MS = 6 * 60 * 1000; // 360_000 ms

export interface ScrapeClaimInput {
  // Current wall-clock time.
  now: Date;
  // startedAt of the most-recent ScrapeRun with status='RUNNING', or null if
  // there is none.
  runningStartedAt: Date | null;
  // Staleness window; a RUNNING row older than this is treated as crashed.
  staleAfterMs?: number;
}

// Decide whether a new claimer may take the scrape slot.
//
// BUSY iff a RUNNING row exists AND its age is strictly less than the staleness
// window (a healthy run is in progress). CLAIM otherwise: no RUNNING row, or the
// RUNNING row is at/over the window (crash recovery — its process died before
// finalizing, so it must not block forever).
//
// Boundary: age exactly === staleAfterMs is CLAIM (the run has used its full
// allotted window without finalizing → treat as crashed).
export function decideScrapeClaim(input: ScrapeClaimInput): 'CLAIM' | 'BUSY' {
  const staleAfterMs = input.staleAfterMs ?? SCRAPE_STALE_AFTER_MS;
  if (input.runningStartedAt == null) return 'CLAIM';
  const ageMs = input.now.getTime() - input.runningStartedAt.getTime();
  // A row dated in the future (clock skew) is fresh → BUSY; a fresh row is BUSY.
  return ageMs < staleAfterMs ? 'BUSY' : 'CLAIM';
}
