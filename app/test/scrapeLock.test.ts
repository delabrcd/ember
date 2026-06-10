import { describe, expect, it } from 'vitest';
import {
  decideScrapeClaim,
  SCRAPE_CLAIM_ADVISORY_KEY,
  SCRAPE_STALE_AFTER_MS,
} from '../src/lib/scheduler/scrapeLock';

// Pure cross-process single-flight decision (issue #136). No DB/browser import —
// the Docker test stage has no DB. Cases hand-worked against the staleness window.

const MIN = 60 * 1000;
const now = new Date('2026-06-10T12:00:00Z');
// `runningStartedAt` = now minus the given number of minutes.
const ago = (mins: number) => new Date(now.getTime() - mins * MIN);

describe('scrapeLock constants', () => {
  it('staleness window is 6 minutes (slightly above the 300s route maxDuration)', () => {
    expect(SCRAPE_STALE_AFTER_MS).toBe(360_000);
    expect(SCRAPE_STALE_AFTER_MS).toBeGreaterThan(300_000);
  });
  it('advisory key is the documented fixed constant', () => {
    expect(SCRAPE_CLAIM_ADVISORY_KEY).toBe(728142);
  });
});

describe('decideScrapeClaim (hand-calculated)', () => {
  it('no RUNNING row → CLAIM', () => {
    expect(decideScrapeClaim({ now, runningStartedAt: null })).toBe('CLAIM');
  });

  it('fresh RUNNING row (age < window) → BUSY', () => {
    // 1 minute old: 60_000 < 360_000 → a healthy run is in progress.
    expect(decideScrapeClaim({ now, runningStartedAt: ago(1) })).toBe('BUSY');
  });

  it('just under the window (age = window − 1ms) → BUSY', () => {
    const startedAt = new Date(now.getTime() - (SCRAPE_STALE_AFTER_MS - 1));
    expect(decideScrapeClaim({ now, runningStartedAt: startedAt })).toBe('BUSY');
  });

  it('exactly at the window (age = window) → CLAIM (boundary, crash recovery)', () => {
    const startedAt = new Date(now.getTime() - SCRAPE_STALE_AFTER_MS);
    expect(decideScrapeClaim({ now, runningStartedAt: startedAt })).toBe('CLAIM');
  });

  it('stale RUNNING row (age >> window) → CLAIM (crashed mid-scrape recovery)', () => {
    // 20 minutes old: process died before finalizing → must not block forever.
    expect(decideScrapeClaim({ now, runningStartedAt: ago(20) })).toBe('CLAIM');
  });

  it('honors an explicit staleAfterMs override', () => {
    // 2-minute-old row with a 1-minute window → stale → CLAIM.
    expect(decideScrapeClaim({ now, runningStartedAt: ago(2), staleAfterMs: 1 * MIN })).toBe('CLAIM');
    // Same row with a 5-minute window → fresh → BUSY.
    expect(decideScrapeClaim({ now, runningStartedAt: ago(2), staleAfterMs: 5 * MIN })).toBe('BUSY');
  });

  it('future-dated RUNNING row (clock skew, negative age) → BUSY', () => {
    // age = −60_000 < 360_000 → treated as fresh/in-progress, stays safe.
    expect(decideScrapeClaim({ now, runningStartedAt: ago(-1) })).toBe('BUSY');
  });
});
