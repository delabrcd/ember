import { describe, expect, it } from 'vitest';
import {
  computeFullScrapeNextRun,
  computePdfFetchNextRun,
  computeIntervalNextRun,
  INTERVAL_DAILY_CAP_MS,
  PDF_PENDING_CAP_MS,
} from '../src/lib/scheduler/cadence';
import { computeNextCheck } from '../src/lib/prediction';

const D = (s: string) => new Date(s + 'T00:00:00Z');
const HOUR = 60 * 60 * 1000;

// Sanity-pin the constants we hand-calculate against (these must match run.ts).
describe('cadence constants', () => {
  it('match the run.ts cap values exactly', () => {
    expect(INTERVAL_DAILY_CAP_MS).toBe(22 * HOUR); // 79_200_000 ms
    expect(PDF_PENDING_CAP_MS).toBe(6 * HOUR); //  21_600_000 ms
  });
});

describe('computeFullScrapeNextRun (hand-calculated)', () => {
  // No statement history -> computeNextCheck returns now + 7 days (SPARSE_GAP_DAYS),
  // which is far beyond both caps, so each cap visibly applies.
  const now = D('2026-06-10');
  const noHistory: Date[] = [];
  const sevenDaysOut = now.getTime() + 7 * 24 * HOUR;

  it('with neither cap equals computeNextCheck', () => {
    const out = computeFullScrapeNextRun(now, {
      statementDates: noHistory,
      hasIntervalData: false,
      hasRecentPendingPdf: false,
    });
    expect(out).toEqual(computeNextCheck(now, noHistory));
    expect(out.getTime()).toBe(sevenDaysOut);
  });

  it('with only the AMI cap returns now + 22h (sooner than the 7-day base)', () => {
    const out = computeFullScrapeNextRun(now, {
      statementDates: noHistory,
      hasIntervalData: true,
      hasRecentPendingPdf: false,
    });
    expect(out.getTime()).toBe(now.getTime() + INTERVAL_DAILY_CAP_MS); // +22h
  });

  it('with only the PDF-pending cap returns now + 6h', () => {
    const out = computeFullScrapeNextRun(now, {
      statementDates: noHistory,
      hasIntervalData: false,
      hasRecentPendingPdf: true,
    });
    expect(out.getTime()).toBe(now.getTime() + PDF_PENDING_CAP_MS); // +6h
  });

  it('with BOTH caps the smaller (6h PDF) wins', () => {
    const out = computeFullScrapeNextRun(now, {
      statementDates: noHistory,
      hasIntervalData: true,
      hasRecentPendingPdf: true,
    });
    expect(out.getTime()).toBe(now.getTime() + PDF_PENDING_CAP_MS); // +6h, not +22h
  });

  it('does NOT apply a cap when computeNextCheck is already sooner than both', () => {
    // Build history so that `now` sits just BEFORE the daily window: computeNextCheck
    // returns min(now + 7d, windowStart). With three perfectly-regular 30-day gaps
    // the spread (MAD) is 0 -> halfDays = MIN_WIGGLE_DAYS = 3. predicted = last + 30d,
    // windowStart = predicted - 3d. Choose `now` = windowStart - 3h so the base check
    // fires in 3h, sooner than both the 6h and 22h caps -> caps must NOT apply.
    const statementDates = [D('2026-03-02'), D('2026-04-01'), D('2026-05-01'), D('2026-05-31')];
    // last = 05-31, +30d -> predicted 06-30, windowStart 06-27.
    const windowStart = D('2026-06-27');
    const baseNow = new Date(windowStart.getTime() - 3 * HOUR);
    // Confirm the base prediction is the 3h-out windowStart (sooner than both caps).
    expect(computeNextCheck(baseNow, statementDates).getTime()).toBe(windowStart.getTime());

    const out = computeFullScrapeNextRun(baseNow, {
      statementDates,
      hasIntervalData: true,
      hasRecentPendingPdf: true,
    });
    // Caps would be baseNow+6h / +22h, both LATER than windowStart (+3h) -> no cap.
    expect(out.getTime()).toBe(windowStart.getTime());
  });
});

describe('computePdfFetchNextRun (hand-calculated)', () => {
  const now = D('2026-06-10');
  it('returns now + 6h when a recent pending PDF exists', () => {
    const out = computePdfFetchNextRun(now, { hasRecentPendingPdf: true });
    expect(out).not.toBeNull();
    expect(out!.getTime()).toBe(now.getTime() + PDF_PENDING_CAP_MS);
  });
  it('returns null (self-deactivate) when no recent pending PDF', () => {
    expect(computePdfFetchNextRun(now, { hasRecentPendingPdf: false })).toBeNull();
  });
});

describe('computeIntervalNextRun (hand-calculated)', () => {
  const now = D('2026-06-10');
  it('returns now + 22h when an AMI meter exists', () => {
    const out = computeIntervalNextRun(now, { hasAmiMeter: true });
    expect(out).not.toBeNull();
    expect(out!.getTime()).toBe(now.getTime() + INTERVAL_DAILY_CAP_MS);
  });
  it('returns null (deactivate) when no AMI meter', () => {
    expect(computeIntervalNextRun(now, { hasAmiMeter: false })).toBeNull();
  });
});
