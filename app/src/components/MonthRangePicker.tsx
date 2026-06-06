'use client';

import { useEffect, useId, useRef, useState } from 'react';
import {
  clampYm,
  isMonthDisabled,
  monthGrid,
  normalizeFromTo,
  ymParts,
  ymToLabel,
} from '@/lib/range';

// The visual month/year range picker popover (issue #39). Replaces the native
// <input type="month"> custom-range fields. A trigger button shows the active
// span ("Jun 2024 – May 2026 ▾") and opens a popover with two linked panes
// (From | To), each a year stepper over a 12-month grid clamped to the data's
// [minYm, maxYm]. Picking a month commits a *custom* range via onChange; if the
// user picks from > to we swap. Pure logic lives in lib/range.ts (unit-tested);
// this component is just wiring + Tailwind, no new dependency.

interface Props {
  fromYm: number;
  toYm: number;
  minYm: number | null;
  maxYm: number | null;
  // True when the active preset is 'custom', so the trigger can reflect that the
  // picker (not a preset chip) owns the current selection.
  active: boolean;
  onChange: (next: { fromYm: number; toYm: number }) => void;
}

// One year-stepped 12-month pane. `selected` is the ym this pane currently owns;
// `otherYm`/`isFrom` let us mark the opposite endpoint and shade the in-between
// span so the from→to relationship is obvious. Disabled months are greyed.
function MonthPane({
  heading,
  selected,
  otherYm,
  isFrom,
  minYm,
  maxYm,
  onPick,
}: {
  heading: string;
  selected: number;
  otherYm: number;
  isFrom: boolean;
  minYm: number | null;
  maxYm: number | null;
  onPick: (ym: number) => void;
}) {
  // The pane's visible year starts on the selected month's year, but can be
  // stepped independently of the selection.
  const [year, setYear] = useState(() => ymParts(selected).year);
  // Re-centre on the selection if it jumps (e.g. a preset chip changed it).
  useEffect(() => {
    setYear(ymParts(selected).year);
  }, [selected]);

  const lo = Math.min(selected, otherYm);
  const hi = Math.max(selected, otherYm);
  // Don't let the year stepper wander past the data window's years.
  const minYear = minYm != null ? ymParts(minYm).year : -Infinity;
  const maxYear = maxYm != null ? ymParts(maxYm).year : Infinity;
  const cells = monthGrid(year);
  const gridRef = useRef<HTMLDivElement>(null);

  // Roving keyboard nav across the 12-cell grid (4 cols × 3 rows).
  const onKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const cols = 4;
    let next = idx;
    if (e.key === 'ArrowRight') next = idx + 1;
    else if (e.key === 'ArrowLeft') next = idx - 1;
    else if (e.key === 'ArrowDown') next = idx + cols;
    else if (e.key === 'ArrowUp') next = idx - cols;
    else return;
    e.preventDefault();
    if (next < 0 || next > 11) return;
    const btns = gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-month]');
    btns?.[next]?.focus();
  };

  return (
    <div className="min-w-[12rem]">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-400">{heading}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous year"
            disabled={year <= minYear}
            onClick={() => setYear((y) => Math.max(minYear, y - 1))}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-700/70 bg-slate-800/40 text-slate-300 transition hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            ‹
          </button>
          <span className="min-w-[3rem] text-center text-xs font-medium tabular-nums text-slate-200" aria-live="polite">
            {year}
          </span>
          <button
            type="button"
            aria-label="Next year"
            disabled={year >= maxYear}
            onClick={() => setYear((y) => Math.min(maxYear, y + 1))}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-slate-700/70 bg-slate-800/40 text-slate-300 transition hover:bg-slate-700 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
          >
            ›
          </button>
        </div>
      </div>
      <div ref={gridRef} role="grid" aria-label={`${heading} month`} className="grid grid-cols-4 gap-1">
        {cells.map((c, idx) => {
          const disabled = isMonthDisabled(c.ym, minYm, maxYm);
          const isSelected = c.ym === selected;
          const inSpan = c.ym >= lo && c.ym <= hi;
          return (
            <button
              key={c.ym}
              type="button"
              data-month={c.ym}
              role="gridcell"
              aria-label={`${isFrom ? 'Start' : 'End'} ${ymToLabel(c.ym)}`}
              aria-pressed={isSelected}
              aria-disabled={disabled}
              disabled={disabled}
              tabIndex={isSelected ? 0 : -1}
              onKeyDown={(e) => onKeyDown(e, idx)}
              onClick={() => onPick(c.ym)}
              className={`rounded-md px-1 py-1 text-xs font-medium transition focus:outline-none focus:ring-1 focus:ring-amber-500/70 ${
                disabled
                  ? 'cursor-not-allowed text-slate-700'
                  : isSelected
                    ? 'bg-amber-500 text-slate-950'
                    : inSpan
                      ? 'bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                      : 'text-slate-300 hover:bg-slate-700/70'
              }`}
            >
              {c.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function MonthRangePicker({ fromYm, toYm, minYm, maxYm, active, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();

  // Close on Escape (returning focus to the trigger) and on outside-click.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const pickFrom = (ym: number) => {
    const next = normalizeFromTo(clampYm(ym, minYm, maxYm), toYm);
    onChange(next);
  };
  const pickTo = (ym: number) => {
    const next = normalizeFromTo(fromYm, clampYm(ym, minYm, maxYm));
    onChange(next);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition focus:outline-none focus:ring-1 focus:ring-amber-500/70 ${
          active
            ? 'border-amber-500/60 bg-slate-800/60 text-slate-100'
            : 'border-slate-700 bg-slate-800/30 text-slate-300 hover:bg-slate-700/60'
        }`}
      >
        <span className="tabular-nums">{ymToLabel(fromYm)}</span>
        <span className="text-slate-500">–</span>
        <span className="tabular-nums">{ymToLabel(toYm)}</span>
        <svg
          className={`h-3 w-3 text-slate-400 transition ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <div
          id={popoverId}
          role="dialog"
          aria-label="Select a custom month range"
          className="absolute left-0 top-full z-50 mt-2 max-w-[calc(100vw-1.5rem)] rounded-2xl border border-slate-700/80 bg-slate-900/95 p-3 shadow-xl shadow-black/40 backdrop-blur"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:gap-5">
            <MonthPane
              heading="From"
              selected={fromYm}
              otherYm={toYm}
              isFrom
              minYm={minYm}
              maxYm={maxYm}
              onPick={pickFrom}
            />
            <div className="hidden w-px self-stretch bg-slate-700/60 sm:block" aria-hidden />
            <MonthPane
              heading="To"
              selected={toYm}
              otherYm={fromYm}
              isFrom={false}
              minYm={minYm}
              maxYm={maxYm}
              onPick={pickTo}
            />
          </div>
          <div className="mt-3 flex items-center justify-between border-t border-slate-800/70 pt-2">
            <span className="text-[11px] text-slate-500">
              {ymToLabel(fromYm)} – {ymToLabel(toYm)}
            </span>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
              className="rounded-md border border-slate-700/70 bg-slate-800/40 px-2 py-0.5 text-[11px] text-slate-300 transition hover:bg-slate-700 hover:text-white"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
