'use client';

// The dashboard header action cluster (issue #73 mobile-density iteration).
//
// PROBLEM: the header buttons — Customize · notifications bell · Tools · Settings
// · "Check for new bills"/Refresh — don't fit on one line on a phone. The earlier
// stopgap let them `flex-wrap` to a second line, which the operator said "looks
// weird." FIX: at ≥sm show the buttons inline exactly as before; below sm collapse
// the overflow-prone ones into a ☰ HAMBURGER MENU whose items trigger the SAME
// handlers the inline buttons do (no duplicated logic — the menu renders the same
// RefreshButton component and calls the same setCustomizing / openTools).
//
// We split responsively with Tailwind, NOT JS width-measuring, so it can't
// overflow: the inline cluster lives in a `hidden sm:flex` container and the
// hamburger in a `flex sm:hidden` one. `sm` (640px) is the breakpoint because the
// inline cluster (~520px of buttons) comfortably fits its own line there, while at
// 390px it would overflow — so the phone gets the menu, the desktop is unchanged.
//
// The notifications BELL stays visible outside the menu at every width: it's
// compact (an icon button) and carries its own dropdown + detail modal, which
// would nest awkwardly inside another dropdown. Only Customize / Tools / Settings
// / Refresh collapse into the hamburger.
//
// The dropdown mirrors the existing popover pattern (NotificationsBell): a
// relatively-positioned wrapper with an absolutely-positioned panel, dark
// slate/amber theme, closing on Escape / outside-click / item-select.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { RefreshButton } from './RefreshButton';
import { NotificationsBell } from './NotificationsBell';
import type { Bill } from './useDashboardData';

// The handlers + state the header actions need, lifted from Dashboard so BOTH the
// inline cluster and the hamburger menu drive the identical logic.
export interface HeaderActionsProps {
  // Whether there's data to act on. When false the Customize / bell / Tools
  // buttons are hidden (today's behaviour) — only Settings + Refresh remain.
  empty: boolean;
  // Customize mode toggle (Phase E, #73). Shown only when a layout exists to edit.
  canCustomize: boolean;
  customizing: boolean;
  onToggleCustomize: () => void;
  // Tools modal opener (defaults to the compare tab, as the inline button did).
  onOpenTools: () => void;
  // Notifications bell inputs (passed straight through).
  accountId: number | null;
  bills: Bill[];
  // Refresh ("Check for new bills") — the delegated-mode RefreshButton wiring.
  onRefreshDone: () => void;
  onRefreshStarted: (runId: number) => void;
  scraping: boolean;
}

// The Customize/Done toggle button — shared label + icon so the inline button and
// the menu item read identically. `inMenu` switches between the pill `.btn` look
// (inline) and a full-width left-aligned menu row (dropdown).
function CustomizeButton({
  customizing,
  onToggle,
  inMenu,
  onAfter,
}: {
  customizing: boolean;
  onToggle: () => void;
  inMenu?: boolean;
  onAfter?: () => void;
}) {
  const icon = customizing ? (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
  ) : (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 21v-4l11-11 4 4L8 21H4zM13 6l4 4" /></svg>
  );
  const label = customizing ? 'Done' : 'Customize';
  if (inMenu) {
    return (
      <MenuItem
        onClick={() => {
          onToggle();
          onAfter?.();
        }}
        active={customizing}
      >
        {icon}
        {label}
      </MenuItem>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`btn border ${
        customizing
          ? 'border-amber-500/60 bg-amber-500/20 text-amber-200 hover:bg-amber-500/30'
          : 'border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// The Tools opener — pill (inline) or menu row (dropdown).
const ToolsIcon = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.3 2.3a1.5 1.5 0 0 1-2.1-2.1z" />
  </svg>
);
const SettingsIcon = (
  <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

// A single dropdown menu row — the dark-theme button look used for every menu
// item (matches the NotificationsBell list rows: full-width, left-aligned, hover
// highlight). `active` tints it amber (the Customize "Done" state).
function MenuItem({
  onClick,
  children,
  active,
}: {
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition hover:bg-slate-800/60 focus:outline-none focus-visible:bg-slate-800/70 ${
        active ? 'text-amber-200' : 'text-slate-200'
      }`}
    >
      {children}
    </button>
  );
}

export function HeaderActions(props: HeaderActionsProps) {
  const {
    empty,
    canCustomize,
    customizing,
    onToggleCustomize,
    onOpenTools,
    accountId,
    bills,
    onRefreshDone,
    onRefreshStarted,
    scraping,
  } = props;

  // The hamburger dropdown open state, with the NotificationsBell close pattern:
  // Escape + outside-click/tap close it, only while open.
  const [menuOpen, setMenuOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    const onPointer = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [menuOpen]);

  const close = () => setMenuOpen(false);

  return (
    <>
      {/* DESKTOP (≥sm): the inline button cluster, unchanged from before — same
          buttons, same order, same styling. `hidden sm:flex` so it only shows once
          the row comfortably fits (it never wraps; the hamburger covers narrower). */}
      <div className="hidden items-center justify-end gap-2 sm:flex">
        {canCustomize && <CustomizeButton customizing={customizing} onToggle={onToggleCustomize} />}
        {!empty && <NotificationsBell accountId={accountId} bills={bills} onOpenCompare={onOpenTools} />}
        {!empty && (
          <button
            type="button"
            onClick={onOpenTools}
            className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700"
          >
            {ToolsIcon}
            Tools
          </button>
        )}
        <Link href="/settings" className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700">
          {SettingsIcon}
          Settings
        </Link>
        <RefreshButton onDone={onRefreshDone} onStarted={onRefreshStarted} running={scraping} />
      </div>

      {/* MOBILE (<sm): the notifications bell stays visible (compact, own dropdown)
          alongside a ☰ hamburger that opens a dropdown with the rest. `flex sm:hidden`
          so it replaces the inline cluster only on narrow screens — no overflow. */}
      <div className="flex items-center justify-end gap-2 sm:hidden">
        {!empty && <NotificationsBell accountId={accountId} bills={bills} onOpenCompare={onOpenTools} />}
        <div className="relative" ref={wrapRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((o) => !o)}
            aria-label="Menu"
            aria-haspopup="true"
            aria-expanded={menuOpen}
            className={`btn border ${
              menuOpen
                ? 'border-amber-500/60 bg-amber-500/20 text-amber-200'
                : 'border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700'
            }`}
          >
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>

          {menuOpen ? (
            <div
              role="menu"
              aria-label="Header actions"
              // Anchored popover under the hamburger, right-aligned, dark slate
              // panel with a border + rounded corners — mirrors the NotificationsBell
              // dropdown. Width clamped to the viewport so it can't overflow a phone.
              className="absolute right-0 z-40 mt-2 flex w-56 max-w-[calc(100vw-1rem)] flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900 py-1 shadow-2xl"
            >
              {canCustomize && (
                <CustomizeButton
                  customizing={customizing}
                  onToggle={onToggleCustomize}
                  inMenu
                  onAfter={close}
                />
              )}
              {!empty && (
                <MenuItem
                  onClick={() => {
                    onOpenTools();
                    close();
                  }}
                >
                  {ToolsIcon}
                  Tools
                </MenuItem>
              )}
              <Link
                href="/settings"
                role="menuitem"
                onClick={close}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-slate-200 transition hover:bg-slate-800/60 focus:outline-none focus-visible:bg-slate-800/70"
              >
                {SettingsIcon}
                Settings
              </Link>
              {/* The actual RefreshButton component (same delegated wiring as inline)
                  so "Check for new bills" runs the identical logic — no duplication.
                  We don't auto-close on click: the button shows its busy/msg/error
                  state in place, and tapping outside dismisses the menu. The wrapper
                  left-aligns it to match the other rows. */}
              <div className="flex items-center px-3 py-2 [&_.btn-primary]:w-full">
                <RefreshButton onDone={onRefreshDone} onStarted={onRefreshStarted} running={scraping} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </>
  );
}
