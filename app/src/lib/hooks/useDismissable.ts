'use client';

// Close-a-popover-on-outside-click-or-Esc hook (issue #150). Four components hand-
// rolled the same effect (NotificationsBell, HeaderActions, MonthRangePicker, and
// IntervalHistory's focus-release). This consolidates it.
//
// Behaviour, preserved from the originals:
//   • Only wires up the global listeners while `open` is true (no listeners at rest).
//   • Esc → onClose; a pointer/mouse event whose target is OUTSIDE `ref` → onClose.
//   • The pointer-down listener defaults to `mousedown` (the popover callers); pass
//     `event: 'pointerdown'` for IntervalHistory's click-away, and `capture: true`
//     to keep its DELIBERATE capture-phase listener (it must see the click-away
//     before any stopPropagation inside the chart). standards §9: ported as-is, no
//     behaviour change.
//
// `onClose` is read through a ref so callers can pass an inline arrow without re-
// binding the global listeners on every render (the originals closed over an inline
// callback with only `[open]` in deps; this keeps that effect identity while staying
// honest about its dependencies).
//
// This is an impure shell (browser-only); it lives under lib/hooks so the
// type-checked lib ESLint rules apply, but the hermetic vitest suite never imports
// it (only components do).

import { useEffect, useRef, type RefObject } from 'react';

type Options = {
  // Which down event closes on an outside target. 'mousedown' (default) matches the
  // popover callers; 'pointerdown' matches IntervalHistory's focus-release.
  event?: 'mousedown' | 'pointerdown';
  // Listen in the capture phase (IntervalHistory needs this).
  capture?: boolean;
};

export function useDismissable(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  options: Options = {},
) {
  const { event = 'mousedown', capture = false } = options;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    const onDown = (e: Event) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener(event, onDown, capture);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener(event, onDown, capture);
    };
  }, [ref, open, event, capture]);
}
