'use client';

import { clampPage } from '@/lib/cockpit';

// The chart-pager controls (issue #38): a prev/next pair flanking the page dots
// and an "n / total" label, shown below the paginated 2×2 chart grid in the
// "fit" cockpit at ≥xl. Pure presentational — the active page + setter are owned
// by Dashboard; this just renders the controls and clamps on click so a stale
// index can never select an out-of-range page.
export function CockpitPager({
  pageCount,
  activePage,
  setPage,
}: {
  pageCount: number;
  activePage: number;
  setPage: (updater: (p: number) => number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-center gap-3 pt-0.5">
      <button
        type="button"
        aria-label="Previous charts"
        onClick={() => setPage((p) => clampPage(p - 1, pageCount))}
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700/70 bg-slate-800/40 text-slate-300 transition hover:bg-slate-700 hover:text-white"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
      <div className="flex items-center gap-1.5" aria-hidden>
        {Array.from({ length: pageCount }).map((_, i) => (
          <span
            key={i}
            className={`h-1.5 w-1.5 rounded-full transition ${i === activePage ? 'bg-amber-400' : 'bg-slate-600'}`}
          />
        ))}
      </div>
      <span className="min-w-[3rem] text-center text-xs tabular-nums text-slate-400">
        {activePage + 1} / {pageCount}
      </span>
      <button
        type="button"
        aria-label="Next charts"
        onClick={() => setPage((p) => clampPage(p + 1, pageCount))}
        className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-slate-700/70 bg-slate-800/40 text-slate-300 transition hover:bg-slate-700 hover:text-white"
      >
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m9 18 6-6-6-6" />
        </svg>
      </button>
    </div>
  );
}
