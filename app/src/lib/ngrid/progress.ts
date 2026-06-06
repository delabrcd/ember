// Pure helpers for the live scrape-progress indicator (issue #40).
//
// The scraper emits a stream of progress lines via its ProgressFn (collect.ts,
// run.ts). While a run is RUNNING we persist the *latest* line into
// ScrapeRun.message so the UI can poll it and show what step we're on; on
// finish, run.ts overwrites message with the final summary/error. These helpers
// keep the (a) formatting and (b) run→indicator-state mapping pure and DB-free
// so they're unit-testable without a browser, Prisma, or React.

export type RunStatus = 'RUNNING' | 'SUCCESS' | 'ERROR';

// A run as the indicator cares about it — the subset the overview's `lastRun`
// and `GET /api/refresh/:id` both return.
export interface ProgressRun {
  id: number;
  status: RunStatus;
  message?: string | null;
  billsAdded?: number | null;
}

// What the banner should render. `phase` drives the animation (spinner vs
// success tick vs error), `text` is the user-facing line, and `done` tells the
// poller it can stop. A null run (no scrape ever) yields `idle` (no banner).
export interface IndicatorState {
  phase: 'idle' | 'running' | 'success' | 'error';
  text: string;
  done: boolean;
}

// Trim and clamp a raw progress line so a runaway message can't bloat the DB row
// or the banner. Mirrors the 500-char clamp run.ts already uses for errors.
export function formatProgressLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500);
}

// First-run scrapes (B2C login + full history + every PDF + weather) can take a
// couple of minutes; surface a gentle hint so a long run doesn't look frozen.
export const FIRST_RUN_HINT = 'This can take a minute on the first run.';

// Map a run (or its absence) to the indicator state. Pure: the UI decides
// rendering, this decides *what* to render. Falls back to sensible defaults when
// `message` hasn't been written yet (very start of a run) or is blank.
export function scrapeIndicatorState(run: ProgressRun | null | undefined): IndicatorState {
  if (!run) return { phase: 'idle', text: '', done: true };
  const msg = (run.message ?? '').trim();
  switch (run.status) {
    case 'RUNNING':
      return { phase: 'running', text: msg || 'Starting…', done: false };
    case 'SUCCESS':
      return { phase: 'success', text: msg || 'Up to date', done: true };
    case 'ERROR':
      return { phase: 'error', text: msg || 'Scrape failed', done: true };
    default:
      return { phase: 'idle', text: '', done: true };
  }
}

// Whether a run is still in progress (drives "keep polling" + "show banner").
export function isRunActive(run: ProgressRun | null | undefined): boolean {
  return !!run && run.status === 'RUNNING';
}
