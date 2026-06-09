'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FIRST_RUN_HINT,
  scrapeIndicatorState,
  type ProgressRun,
  type RunStatus,
} from '@/lib/ngrid/progress';

// Live scrape-progress indicator (issue #40). A prominent, animated banner shown
// whenever a scrape is in flight — it polls GET /api/refresh/:id, surfaces the
// current step (logging in → fetching bills → downloading PDFs → weather), and
// resolves to a brief success/error state before clearing. The poller/state are
// driven by the pure scrapeIndicatorState() mapping so behavior is testable.

const POLL_MS = 3000;
// How long to keep the resolved (success/error) banner on screen before it
// auto-clears, so the run doesn't vanish the instant it finishes.
const SETTLE_MS = 6000;

// Lifted state: Dashboard owns this so a single banner tracks both the manual
// button and any run already in flight when the page loads (`initialRun` from
// the overview's `lastRun`). Returns the live run + a `track()` to adopt a new
// run id, plus an `onResolved` you fire to refresh dashboard data on SUCCESS.
export function useScrapeProgress(
  initialRun: ProgressRun | null,
  onResolved?: (run: ProgressRun) => void
): { run: ProgressRun | null; track: (runId: number) => void; dismiss: () => void } {
  // Seed from the overview only while a run is actually in flight; a finished
  // run from a past page-load shouldn't pop a banner on every refresh.
  const [run, setRun] = useState<ProgressRun | null>(
    initialRun && initialRun.status === 'RUNNING' ? initialRun : null
  );
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resolvedRef = useRef(onResolved);
  resolvedRef.current = onResolved;

  const clearTimers = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (settleRef.current) clearTimeout(settleRef.current);
    pollRef.current = null;
    settleRef.current = null;
  };

  const dismiss = useCallback(() => {
    clearTimers();
    setRun(null);
  }, []);

  // Adopt a run id and poll it until it resolves. Idempotent for a given id.
  const track = useCallback((runId: number) => {
    clearTimers();
    setRun({ id: runId, status: 'RUNNING', message: null });
    const poll = async () => {
      try {
        const r = await fetch(`/api/refresh/${runId}`, { cache: 'no-store' });
        if (!r.ok) return;
        const next: {
          id: number;
          status: RunStatus;
          message?: string | null;
          billsAdded?: number | null;
        } = await r.json();
        setRun(next);
        if (next.status !== 'RUNNING') {
          if (pollRef.current) clearInterval(pollRef.current);
          pollRef.current = null;
          if (next.status === 'SUCCESS') resolvedRef.current?.(next);
          // Leave the resolved banner up briefly, then auto-clear.
          settleRef.current = setTimeout(() => setRun(null), SETTLE_MS);
        }
      } catch {
        /* transient — keep polling */
      }
    };
    pollRef.current = setInterval(poll, POLL_MS);
    void poll(); // fire immediately so the first step shows without a 3s wait
  }, []);

  // If the page loaded mid-run, start tracking that run right away.
  const adopted = useRef(false);
  useEffect(() => {
    if (!adopted.current && initialRun && initialRun.status === 'RUNNING') {
      adopted.current = true;
      track(initialRun.id);
    }
  }, [initialRun, track]);

  useEffect(() => clearTimers, []);

  return { run, track, dismiss };
}

// The banner itself: an animated spinner/pulse + the current step + a first-run
// hint while running; a success tick or an error + retry once resolved.
export function ScrapeProgressBanner({
  run,
  onRetry,
  onDismiss,
}: {
  run: ProgressRun | null;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const state = scrapeIndicatorState(run);
  if (state.phase === 'idle') return null;

  if (state.phase === 'running') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="shrink-0 overflow-hidden rounded-lg border border-amber-500/40 bg-amber-500/10"
      >
        {/* Indeterminate progress shimmer along the top edge. */}
        <div className="h-0.5 w-1/3 animate-pulse rounded-full bg-amber-400/70" />
        <div className="flex items-center gap-3 px-4 py-2.5">
          <svg className="h-5 w-5 shrink-0 animate-spin text-amber-400" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
            <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
          </svg>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-amber-100">{state.text}</div>
            <div className="text-xs text-amber-200/70">{FIRST_RUN_HINT}</div>
          </div>
        </div>
      </div>
    );
  }

  if (state.phase === 'success') {
    const added = run?.billsAdded ?? 0;
    const summary = added > 0 ? `${added} new bill${added === 1 ? '' : 's'}` : state.text;
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex shrink-0 items-center gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-4 py-2.5"
      >
        <svg className="h-5 w-5 shrink-0 text-emerald-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
        <div className="min-w-0 flex-1 truncate text-sm font-medium text-emerald-100">{summary}</div>
        {onDismiss && (
          <button type="button" onClick={onDismiss} className="text-xs text-emerald-200/70 hover:text-emerald-100">
            Dismiss
          </button>
        )}
      </div>
    );
  }

  // error
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5"
    >
      <svg className="h-5 w-5 shrink-0 text-rose-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M12 8v4M12 16h.01" />
      </svg>
      <div className="min-w-0 flex-1 truncate text-sm font-medium text-rose-100">{state.text}</div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="btn border border-rose-700/70 bg-rose-900/40 text-rose-200 hover:bg-rose-800/60"
        >
          Retry
        </button>
      )}
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="text-xs text-rose-200/70 hover:text-rose-100">
          Dismiss
        </button>
      )}
    </div>
  );
}
