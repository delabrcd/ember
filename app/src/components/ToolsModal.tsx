'use client';

// On-demand "Tools" modal (UX refactor). The interactive tools — Compare periods
// (#47) and the Supply what-if (#48) — are powerful but rarely used, so instead of
// sitting always-visible below the stat strip they now live here, behind a header
// "Tools" button and the "vs last year" card. This is presentation only: it hosts
// the EXISTING ComparePeriods / SupplyWhatIf components unchanged (same props, same
// behaviour) and just switches between them with a tab strip.
//
// The overlay is a self-contained centered modal (portal to <body> so chart cards'
// backdrop-filter can't trap the fixed positioning — see Modal.tsx for the same
// note). It closes on Esc, backdrop click and an explicit ✕, and locks body scroll
// while open. Sized for the tools (max-w-3xl) with the panel body scrolling
// internally when a tool runs long.

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MonthRow } from '@/lib/chartSpec';
import { ComparePeriods } from './ComparePeriods';
import { SupplyWhatIf } from './SupplyWhatIf';

export type ToolsTab = 'compare' | 'whatif';

const TABS: { value: ToolsTab; label: string }[] = [
  { value: 'compare', label: 'Compare periods' },
  { value: 'whatif', label: 'Supply what-if' },
];

export function ToolsModal({
  open,
  onClose,
  initialTab = 'compare',
  rows,
  rangedRows,
  currencyDecimals,
}: {
  open: boolean;
  onClose: () => void;
  // The tab the modal opens to (the vs-last-year card opens straight to Compare).
  initialTab?: ToolsTab;
  // ComparePeriods works over the full series (it does its own preset windowing);
  // SupplyWhatIf back-tests the on-screen range — same split as the old inline
  // renders, so behaviour is unchanged.
  rows: MonthRow[];
  rangedRows: MonthRow[];
  currencyDecimals: number;
}) {
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<ToolsTab>(initialTab);
  useEffect(() => setMounted(true), []);

  // Sync the active tab to the requested one each time the modal opens, so a
  // trigger (e.g. the vs-last-year card) lands on its tool even if the user last
  // left the modal on the other tab.
  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="Tools">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 flex max-h-[90vh] w-[96vw] max-w-3xl flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl">
        {/* Header: tab strip + close. */}
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-800/70 px-4 py-3">
          <div className="flex items-center gap-1 rounded-lg border border-slate-800 bg-slate-800/40 p-0.5">
            {TABS.map((t) => (
              <button
                key={t.value}
                type="button"
                onClick={() => setTab(t.value)}
                aria-pressed={tab === t.value}
                className={`rounded-md px-3 py-1 text-xs font-medium transition ${
                  tab === t.value
                    ? 'bg-slate-700 text-slate-100'
                    : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-slate-700/70 text-slate-400 transition hover:bg-slate-700 hover:text-slate-100 focus:outline-none focus:ring-1 focus:ring-amber-500/60"
          >
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Active tool. The tools render their own card chrome; the body scrolls
            internally when a tool runs long. */}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === 'compare' ? (
            <ComparePeriods rows={rows} currencyDecimals={currencyDecimals} />
          ) : (
            <SupplyWhatIf rows={rangedRows} currencyDecimals={currencyDecimals} />
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
