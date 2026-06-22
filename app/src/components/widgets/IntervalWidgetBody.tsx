'use client';

// The shared loading / error / empty / content scaffold for the self-fetching
// interval widgets (issue #150). IntervalLoadShape and IntervalHeatmap rendered a
// byte-identical skeleton + error card, and an empty card whose only difference is
// the wording — so the empty message is a prop. The populated branch renders
// `children` (the widget's own Recharts/SVG tree). The outer flex-col box (so the
// chart area takes the remaining cell height) is preserved verbatim.
//
// IntervalHistory does NOT use this — it has its own SWR/skeleton states (#156).

import type { ReactNode } from 'react';

export function IntervalWidgetBody({
  height,
  loading,
  errored,
  empty,
  emptyMessage,
  children,
}: {
  height: number | string;
  loading: boolean;
  errored: boolean;
  empty: boolean;
  emptyMessage: ReactNode;
  children: ReactNode;
}) {
  return (
    <div style={{ height }} className="flex w-full flex-col">
      {loading ? (
        // Loading: a muted skeleton bar filling the cell.
        <div className="flex h-full w-full items-center justify-center">
          <div className="h-full w-full animate-pulse rounded-lg bg-slate-800/40" />
        </div>
      ) : errored ? (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-xs text-slate-400">
          Couldn&apos;t load interval data — try again on the next check.
        </div>
      ) : empty ? (
        // Empty: a friendly muted message, NOT a broken blank chart.
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-sm text-slate-400">
          {emptyMessage}
        </div>
      ) : (
        children
      )}
    </div>
  );
}
