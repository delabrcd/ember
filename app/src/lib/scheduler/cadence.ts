// Pure per-task cadence functions (docs/scheduler-v2-plan.md §5).
//
// This is the SOLE source of truth for the cadence cap constants
// (INTERVAL_DAILY_CAP_MS / PDF_PENDING_CAP_MS / PDF_PENDING_RECENT_DAYS) — the
// seed and the scrape handlers import them from here.
//
// Hermetic: NO prisma/browser imports. Facts are injected by the caller so the
// unit suite stays pure (mirrors the shipped `hasIntervalData` probe pattern).
import { computeNextCheck } from '@/lib/prediction';

// ~daily: keep an AMI-interval account on at least a daily cadence so the
// 15-minute archive stays continuous (caps the bill-prediction back-off).
export const INTERVAL_DAILY_CAP_MS = 22 * 60 * 60 * 1000;
// ~6h: while a RECENT bill is still missing its PDF, tighten the back-off so
// the lagging PDF (NG publishes the row ~1-3d before the PDF) is fetched soon.
export const PDF_PENDING_CAP_MS = 6 * 60 * 60 * 1000;
// Only bills with a statementDate within this many days pin the tighter PDF
// cadence (so an ancient bill that never got a PDF can't pin it forever).
export const PDF_PENDING_RECENT_DAYS = 35;

// full-scrape cadence: start from the pure computeNextCheck, then apply the AMI
// cap (min) if the account has interval data, then the PDF-pending cap (min) if a
// recent pending PDF exists. Smaller cap wins; caps never push the time LATER (they
// only ever pull it sooner). Per the plan the caps stay on full-scrape
// initially for safety even though interval-pull/pdf-fetch will own them.
export function computeFullScrapeNextRun(
  now: Date,
  facts: { statementDates: Date[]; hasIntervalData: boolean; hasRecentPendingPdf: boolean }
): Date {
  let nextCheckAt = computeNextCheck(now, facts.statementDates);
  if (facts.hasIntervalData) {
    const cap = new Date(now.getTime() + INTERVAL_DAILY_CAP_MS);
    if (cap < nextCheckAt) nextCheckAt = cap;
  }
  if (facts.hasRecentPendingPdf) {
    const cap = new Date(now.getTime() + PDF_PENDING_CAP_MS);
    if (cap < nextCheckAt) nextCheckAt = cap;
  }
  return nextCheckAt;
}

// pdf-fetch cadence: ~6h while a recent pending PDF exists, else null =
// self-deactivate (full-scrape re-arms it when a new pending bill appears).
export function computePdfFetchNextRun(
  now: Date,
  facts: { hasRecentPendingPdf: boolean }
): Date | null {
  return facts.hasRecentPendingPdf ? new Date(now.getTime() + PDF_PENDING_CAP_MS) : null;
}

// interval-pull cadence: ~daily while an AMI meter exists, else null =
// deactivate (the handler records SKIPPED on a first run with no AMI meter).
export function computeIntervalNextRun(
  now: Date,
  facts: { hasAmiMeter: boolean }
): Date | null {
  return facts.hasAmiMeter ? new Date(now.getTime() + INTERVAL_DAILY_CAP_MS) : null;
}
