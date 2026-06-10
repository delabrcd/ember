'use client';

// ChartShell — the shared card chrome for every dashboard chart (issue: interval
// chart chrome). Extracted from ConfigurableChart so the monthly charts AND the
// self-fetching interval widgets render the SAME card: a header (title/subtitle +
// a "Customize" gear that toggles a settings popover + an "Expand" button), the
// settings popover, the chart body, and a fullscreen Expand modal (body at 80vh +
// the settings panel on the side).
//
// The body is supplied as a render prop so each caller keeps its own Recharts
// tree (and loading/empty states) — ChartShell owns ONLY the chrome + menu/expand
// state. `settings` (optional) is the popover/expand-side content; when omitted,
// the Customize gear is hidden (a chart with no configurable options).

import { useState } from 'react';
import { Modal } from './Modal';

export function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick}
      className="rounded-lg border border-slate-700/70 bg-slate-800/40 p-1.5 text-slate-300 transition hover:bg-slate-700 hover:text-white">
      {children}
    </button>
  );
}

export const GearIcon = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);
export const ExpandIcon = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
  </svg>
);
export const CloseIcon = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

// `fill` makes the chart FILL its placed grid cell (Phase E, #73). The cell's
// height is supplied by the react-grid-layout engine — at the lg/fit breakpoint
// it's the runtime-computed `rowHeight × h` (the no-scroll fit COMPUTED from the
// measured chrome height in WidgetLayout); at scrolling breakpoints it's a fixed
// rowHeight × h. Either way the cell already has a definite pixel height, so the
// chart just needs to fill it 100% top-to-bottom.
//
// To make Recharts' ResponsiveContainer (height="100%") measure a non-zero box,
// the fill card is a flex COLUMN whose body is `flex-1 min-h-0` — the cell's
// definite height flows down the flex chain to the body, which the
// ResponsiveContainer then fills.
//
// `height` is the fixed pixel height for the non-fill layout (the demo gallery
// and any non-grid caller).

export function ChartShell({
  title,
  subtitle,
  fill = false,
  height = 288,
  body,
  settings,
}: {
  title: string;
  subtitle?: string;
  fill?: boolean;
  height?: number;
  body: (h: number | string) => React.ReactNode;
  settings?: React.ReactNode;
}): JSX.Element {
  const [menu, setMenu] = useState(false);
  const [expand, setExpand] = useState(false);

  return (
    <div className={`card relative ${fill ? 'flex h-full min-h-0 flex-col !p-2.5' : ''}`}>
      <div className={`flex shrink-0 items-start justify-between ${fill ? 'mb-1' : 'mb-2'}`}>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-slate-100">{title}</h3>
          {subtitle && !fill && <p className="truncate text-xs text-slate-400">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {/* Discoverable "Customize" affordance (issue #24) — a labelled gear, not a bare icon. */}
          {settings && (
            <button
              title="Customize this chart"
              onClick={() => setMenu((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition ${
                menu
                  ? 'border-amber-500/60 bg-amber-500/15 text-amber-200'
                  : 'border-slate-700/70 bg-slate-800/40 text-slate-300 hover:bg-slate-700 hover:text-white'
              }`}
            >
              {GearIcon}
              <span className="hidden sm:inline">Customize</span>
            </button>
          )}
          <IconButton title="Expand" onClick={() => setExpand(true)}>{ExpandIcon}</IconButton>
        </div>
      </div>

      {menu && settings && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
          <div className="absolute right-4 top-14 z-20 max-h-[70vh] w-64 overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-4 shadow-2xl">
            {settings}
          </div>
        </>
      )}

      {fill ? (
        // Fill the placed grid cell: `flex-1 min-h-0` takes the remaining height
        // of the flex-column card (whose height is the cell's definite px height
        // from the RGL engine), and the body draws into it at 100%. min-h-0 lets
        // the flex child actually shrink so the ResponsiveContainer measures the
        // real box instead of overflowing.
        <div className="min-h-0 flex-1">{body('100%')}</div>
      ) : (
        body(height)
      )}

      <Modal open={expand} onClose={() => setExpand(false)}>
        <div className="mb-3 flex shrink-0 items-start justify-between">
          <div>
            <h3 className="text-lg font-semibold text-slate-100">{title}</h3>
            {subtitle && <p className="text-xs text-slate-400">{subtitle}</p>}
          </div>
          <IconButton title="Close" onClick={() => setExpand(false)}>{CloseIcon}</IconButton>
        </div>
        {settings ? (
          <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[1fr_260px]">
            {body('80vh')}
            <div className="overflow-auto rounded-xl border border-slate-800 bg-slate-900/50 p-4">
              {settings}
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1">{body('80vh')}</div>
        )}
      </Modal>
    </div>
  );
}
