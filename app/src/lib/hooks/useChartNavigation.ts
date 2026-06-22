'use client';

// The IntervalHistory mouse-navigation shell (issue #156 extract; WS5–WS11). This is
// the impure DOM-listener side of the "Usage history" widget's FOCUSED navigation —
// wheel zoom/pan + Ctrl+drag pan — plus the focus/modifier tracking that drives the
// chart cursor. ALL the WINDOW MATH stays PURE in lib/intervalZoom.ts
// (zoomWindowAroundCenter / panWindow / pixelPanDeltaMs / navCursor); this hook owns
// only focus state, the two native non-passive listeners, and the modifier refs.
//
// THE HARD-WON INVARIANTS (preserved verbatim — WS1–WS11 stale-closure pan fixes):
//   • The native listeners read the CURRENT window from the FRESH `curWindowRef`
//     (a stable ref the widget keeps in lockstep), NOT a captured `zoom` closure — a
//     burst of wheel notches fires faster than React commits `setZoom` + re-binds the
//     listener, so reading the ref makes each notch ACCUMULATE from where the last one
//     committed (a clean constant-span slide) instead of from a stale window.
//   • Focus is read from the always-fresh `focusedRef` so a shift+wheel fired the
//     instant the chart is clicked still preventDefault()s (no stale-closure leak).
//   • macOS / many trackpads convert shift+scroll into a HORIZONTAL wheel (deltaX set,
//     shiftKey=FALSE) — so the PAN is recognised by EITHER the shift key OR a
//     predominantly-horizontal delta (`isPan`), and the page never scrolls from a
//     captured gesture (unconditional preventDefault on the owned path).
//   • The wheel handler `e.stopPropagation()`s so the cockpit paginator's ANCESTOR
//     wheel listener can't also act on the horizontal wheel and flip the page (a pan
//     that "works once then stops"). preventDefault only stops the browser's default
//     scroll, NOT ancestor JS listeners — so we stop propagation too.
//
// The widget passes `bodyRef` (the focus host the listeners bind to), the fresh
// `curWindowRef`, `applyNavWindow` (the clamp-and-commit), the global bounds, and the
// current `dataLength` (the gestures no-op with no rows but the page stays prevented).
// The hook returns the focus state + setter, the chart cursor, and the refs the
// widget's Recharts drag-select handlers also read (`hoverTsRef`, `panDragRef`,
// `ctrlDownRef`).
//
// Impure browser shell under lib/hooks (the type-checked lib ESLint applies); the
// hermetic vitest suite never imports it.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
  type RefObject,
} from 'react';
import {
  zoomWindowAroundCenter,
  panWindow,
  pixelPanDeltaMs,
  navCursor,
  type WindowMs,
} from '@/lib/intervalZoom';
import { useDismissable } from './useDismissable';

// ---- WS10: plot pixel geometry ----------------------------------------------
// The Ctrl+drag pan (WS10) converts a raw pixel delta into a window shift, so it
// needs the PLOT's pixel width (the drawable area inside the axes). We derive it
// from the chart body's measured width minus the horizontal insets that aren't
// plot: the LineChart `margin.left`/`margin.right` plus the YAxis `width`. These
// MUST mirror the values on the <LineChart margin> and <YAxis width> in the widget —
// they only scale pan sensitivity, so an exact match isn't critical, but keep them in
// sync. (The X axis sits at the bottom, so it doesn't eat horizontal plot width.)
export const CHART_MARGIN_LEFT = 0;
export const CHART_MARGIN_RIGHT = 10;
export const Y_AXIS_WIDTH = 42;
// Total horizontal pixels reserved for chrome (everything that isn't plot width).
const PLOT_X_INSET = CHART_MARGIN_LEFT + CHART_MARGIN_RIGHT + Y_AXIS_WIDTH;

// ---- WS5 mouse-navigation tuning --------------------------------------------
// Wheel zoom step: the multiplier applied to the current span PER notch. Zoom-in
// contracts the span to 88% (factor 0.88 ≈ a 12% tighter window); zoom-out is the
// reciprocal (≈1.136). ~10–18% is a good feel; 12% is the middle.
const WHEEL_ZOOM_IN_FACTOR = 0.88;
const WHEEL_ZOOM_OUT_FACTOR = 1 / WHEEL_ZOOM_IN_FACTOR;
// Shift+wheel pan step: shift the window by this fraction of its CURRENT span per
// notch (~10–15%). Sign comes from the wheel deltaY direction.
const WHEEL_PAN_FRACTION = 0.12;

// Hard minimum zoom window (issue #141). 1 hour is the floor because the finest grain
// the data ever reaches is 15-min electric: an hour-wide window already shows the
// densest data the chart can hold (~4 points at 15-min).
const MIN_ZOOM_SPAN_MS = 60 * 60_000;

// The in-flight Ctrl+drag pan, if any (WS10: PIXEL-ANCHORED). Captured at native
// mousedown: the START window (`fromMs`/`toMs`), the START cursor `clientX`, and the
// plot's pixel width.
export type PanDrag = {
  startClientX: number;
  fromMs: number;
  toMs: number;
  plotWidthPx: number;
};

type Bounds = { boundsFromMs: number; boundsToMs: number; boundsValid: boolean };

export function useChartNavigation(
  bodyRef: RefObject<HTMLDivElement | null>,
  // A FRESH mirror of the current window the widget keeps in lockstep (the native
  // listeners read this, NOT a stale `zoom` closure — the WS10/WS11 fix). The widget
  // initializes it (useRef({…})) and writes it synchronously, so `.current` is always
  // present → MutableRefObject (non-nullable current), matching the original deref.
  curWindowRef: MutableRefObject<{ fromMs: number; toMs: number }>,
  applyNavWindow: (next: WindowMs, runNow?: boolean) => void,
  bounds: Bounds,
  // The rendered point count — the gestures no-op with no rows (but the page stays
  // prevented). Read fresh so the wheel listener re-binds when rows arrive.
  dataLength: number,
): {
  focused: boolean;
  setFocused: (f: boolean) => void;
  chartCursor: ReturnType<typeof navCursor>;
  // Refs the widget's Recharts drag-select handlers also read AND write (e.g.
  // `panDragRef.current = null` in resetZoom, `hoverTsRef.current = pt.ts` on move) —
  // MutableRefObject so the component can assign `.current` (RefObject is readonly).
  hoverTsRef: MutableRefObject<number | null>;
  panDragRef: MutableRefObject<PanDrag | null>;
  ctrlDownRef: MutableRefObject<boolean>;
  // Hover handlers for the chart-body wrapper (WS9 discoverable modifier cursor).
  onBodyMouseEnter: () => void;
  onBodyMouseLeave: () => void;
} {
  const { boundsFromMs, boundsToMs, boundsValid } = bounds;

  // Whether the chart is FOCUSED (clicked). The wheel/pan gestures engage ONLY
  // while focused, and the native wheel listener captures page-scroll ONLY while
  // focused — so scrolling past an unfocused chart is never trapped.
  const [focused, setFocused] = useState(false);
  // WS7: a FRESH mirror of `focused` for the native wheel listener. The listener's
  // closure can be stale right after a click focuses the chart (the effect that
  // re-binds it on `focused` hasn't run yet), which let the very first shift+wheel
  // leak through to the page. Reading this ref means preventDefault() is never
  // skipped for a focused chart due to a stale closure. Kept in sync below.
  const focusedRef = useRef(false);

  // ---- WS6 navigation polish state ------------------------------------------
  // Reactive modifier/drag state, used ONLY to derive the chart cursor (the GESTURE
  // logic still reads the always-fresh refs below). `ctrlDown`/`shiftDown` mirror the
  // held modifiers; `ctrlDragging` is true while a Ctrl+drag pan is actually in
  // flight. We keep these as state (not refs) because the cursor must RE-RENDER when a
  // key is pressed/released. navCursor({focused,…}) maps them to the CSS cursor.
  const [ctrlDown, setCtrlDown] = useState(false);
  const [shiftDown, setShiftDown] = useState(false);
  const [ctrlDragging, setCtrlDragging] = useState(false);
  // WS9 (Fix 1): whether the cursor is currently OVER the chart body. Drives the
  // modifier-cursor hint on hover (navCursor's `hovering`).
  const [hovering, setHovering] = useState(false);

  // The time (epoch-ms) under the cursor, tracked from the Recharts onMouseMove via
  // pointFromActive. The wheel handler uses it as the zoom center (fallback: midpoint).
  const hoverTsRef = useRef<number | null>(null);
  // Whether Ctrl is currently held — tracked from document keydown/keyup AND from the
  // native mouse/wheel events, because Recharts' synthetic mouse-state object doesn't
  // reliably expose modifier keys. Drives the Ctrl+drag pan branch.
  const ctrlDownRef = useRef(false);
  // The in-flight Ctrl+drag pan, if any (WS10: PIXEL-ANCHORED). While set, the Recharts
  // plain drag-select is suppressed.
  const panDragRef = useRef<PanDrag | null>(null);

  // WS7: keep the wheel listener's fresh-focus ref in lockstep with `focused`, so a
  // shift+wheel fired the instant the chart is clicked still preventDefault()s (the
  // stale closure that caused the page-scroll leak can't win against a ref read).
  useEffect(() => {
    focusedRef.current = focused;
  }, [focused]);

  // ---- WS5 focus management: Esc + click-away release -----------------------
  // While focused, listen on the document for: (1) Esc → blur; (2) a pointer-down
  // OUTSIDE the chart body → blur (click-away). Listening on the document (not the
  // wrapper's onBlur) is robust: the SVG/Recharts internals steal focus and a real
  // <div> blur never fires reliably here, so we drive focus explicitly. Only wired
  // up while focused, so it adds no global listeners at rest. (#150: the shared
  // useDismissable hook, with the DELIBERATE capture-phase + pointerdown options so
  // we see the click-away before any stopPropagation inside the chart.)
  useDismissable(bodyRef, focused, () => setFocused(false), {
    event: 'pointerdown',
    capture: true,
  });

  // Track Ctrl globally so the Ctrl+drag pan can detect the modifier even though the
  // Recharts synthetic mouse-state object doesn't expose it. Cheap, always-on (a
  // boolean flip); the gesture only reads ctrlDownRef while focused + dragging.
  //
  // WS6 EXTENSION: the same handler now also mirrors Ctrl AND Shift into the reactive
  // `ctrlDown`/`shiftDown` STATE that drives the modifier→cursor feedback (navCursor).
  // The gesture handlers keep reading ctrlDownRef (always fresh, no render needed);
  // the state copies exist purely so a press/release RE-RENDERS the cursor. Updated on
  // BOTH keydown and keyup so releasing a key restores the cursor. setState is a no-op
  // when the value is unchanged, so the held-key key-repeat doesn't thrash renders.
  useEffect(() => {
    const sync = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey;
      const shift = e.shiftKey;
      ctrlDownRef.current = ctrl;
      setCtrlDown(ctrl);
      setShiftDown(shift);
    };
    // A window blur (alt-tab, focus loss) can swallow the keyup → the modifier would
    // appear stuck-down. Clear the reactive cursor state on blur to self-heal.
    const onBlur = () => {
      ctrlDownRef.current = false;
      setCtrlDown(false);
      setShiftDown(false);
    };
    window.addEventListener('keydown', sync);
    window.addEventListener('keyup', sync);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', sync);
      window.removeEventListener('keyup', sync);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // Derive the chart cursor (WS6) from the focus + modifier + active-drag state via
  // the PURE navCursor resolver. Recomputed on every relevant state change. Not
  // focused → 'default' (gestures inert).
  const chartCursor = navCursor({ focused, ctrlDown, shiftDown, ctrlDragging, hovering });

  // ---- WS5/WS7/WS9: native non-passive wheel listener (zoom / shift-pan) -----
  // React's onWheel is PASSIVE — it can't preventDefault to stop page scroll. So we
  // attach a native listener with { passive: false } on the chart body. Wheel up =
  // zoom IN, down = zoom OUT, centered on hoverTsRef (fallback: window midpoint);
  // Shift+wheel = pan. The window update is immediate (and so, via the derived `view`,
  // the line slides/scales LIVE); the refetch is debounced.
  //
  // WS9 GATING: the PAN (shift+wheel) is captured on HOVER, focused or not; the ZOOM
  // (plain wheel) STAYS focus-gated so plain page-scrolling past an unfocused chart
  // still works. preventDefault fires BEFORE the no-data early return, and focus is
  // read from the always-fresh `focusedRef` (no stale-closure race on the first wheel
  // after a click). We read BOTH deltaY and deltaX (shift+wheel emits a horizontal
  // delta on many setups).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      // WS9: the PAN (shift+wheel) is captured on hover, focused or not; the ZOOM
      // (plain wheel) needs focus. macOS and many trackpads convert shift+scroll into a
      // HORIZONTAL wheel — deltaX set, shiftKey=FALSE — so recognise a pan by EITHER the
      // shift key OR a predominantly-horizontal delta. Read focus from the always-fresh
      // ref (not the stale closure).
      const horizontalWheel = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      const isPan = e.shiftKey || horizontalWheel;
      if (!focusedRef.current && !isPan) return;
      e.preventDefault();
      // STOP the event from bubbling to the cockpit paginator's ancestor wheel
      // listener (WidgetLayout's trackpad horizontal-scroll paging), which would
      // otherwise also act on this horizontal wheel and FLIP THE PAGE — sliding the
      // chart off-screen so a pan "works once then stops". preventDefault only
      // suppresses the browser's default scroll, NOT ancestor JS listeners; we own
      // this gesture, so stop propagation too.
      e.stopPropagation();
      // Past here the page is already prevented; the gesture math no-ops (returns)
      // when we can't compute a window — but the page stays put either way.
      if (!boundsValid || dataLength === 0) return;
      ctrlDownRef.current = e.ctrlKey || e.metaKey; // keep Ctrl tracking fresh
      // WS11: read the CURRENT window from the FRESH committed mirror (`curWindowRef`),
      // NOT the captured `zoom` closure — a burst of wheel notches fires faster than
      // React commits `setZoom` + re-binds this listener, so the closure's window was
      // STALE. Reading the ref means each notch ACCUMULATES from where the last one
      // committed, with a CONSTANT span (panWindow preserves the span and only clamps
      // the SHIFT at the global edge). Mirrors WS10's curWindowRef fix.
      const cur = curWindowRef.current;
      const fromMs = cur.fromMs;
      const toMs = cur.toMs;
      if (isPan) {
        // Shift+wheel (or a horizontal wheel) → pan. Use whichever wheel axis carries
        // the delta. A positive delta pans RIGHT (later time); negative pans LEFT.
        const raw = Math.abs(e.deltaX) >= Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (raw === 0) return; // nothing to pan (page already prevented)
        const span = toMs - fromMs;
        const dir = raw > 0 ? 1 : -1;
        const next = panWindow(
          fromMs,
          toMs,
          dir * WHEEL_PAN_FRACTION * span,
          boundsFromMs,
          boundsToMs,
        );
        applyNavWindow(next);
      } else {
        // Wheel up (deltaY < 0) → zoom IN; wheel down → zoom OUT. Center on the
        // hovered ts, falling back to the window midpoint when no hover is tracked.
        const raw = e.deltaY !== 0 ? e.deltaY : e.deltaX;
        if (raw === 0) return; // no scroll magnitude → nothing to zoom
        const center =
          hoverTsRef.current != null && Number.isFinite(hoverTsRef.current)
            ? hoverTsRef.current
            : (fromMs + toMs) / 2;
        const factor = raw < 0 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR;
        const next = zoomWindowAroundCenter(
          fromMs,
          toMs,
          center,
          factor,
          boundsFromMs,
          boundsToMs,
          MIN_ZOOM_SPAN_MS,
        );
        applyNavWindow(next);
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // WS11: `zoom` is no longer a dep — the handler reads the CURRENT window from the
    // fresh `curWindowRef.current` (a stable ref), so the listener no longer needs to
    // re-bind on every wheel-notch's `setZoom`. That removal is also what makes the pan
    // accumulate correctly: a stable handler reading a fresh ref can't read a stale
    // closure mid-burst. The remaining deps fully determine the gesture math.
  }, [boundsValid, boundsFromMs, boundsToMs, dataLength, applyNavWindow, bodyRef, curWindowRef]);

  // ---- WS10: native Ctrl+drag PAN (pixel-anchored) --------------------------
  // The Ctrl+drag pan is driven by the RAW PIXEL delta from the drag START — NOT the
  // nearest data point's ts under the (live-moving) numeric domain. Anchoring to fixed
  // START values means there's NO feedback loop: the same `deltaPx` always yields the
  // same window, and the window tracks the cursor 1:1 and STAYS on release.
  //
  // We need `e.clientX` + the plot pixel width, neither of which Recharts' synthetic
  // mouse-state exposes — so this is a NATIVE listener on the chart body. On
  // Ctrl+mousedown we capture the START window (from the fresh `curWindowRef`), the
  // START clientX, and the plot width. Each move: `deltaPx = clientX − startClientX`;
  // `deltaMs = -pixelPanDeltaMs(deltaPx, plotWidthPx, startSpanMs)` (the NEGATION is the
  // "grab the plot" direction); then `panWindow` clamps and `applyNavWindow` pushes it
  // into the live domain. mouseup forces a synchronous overscan reconcile of the final
  // window. The non-Ctrl path is left entirely to Recharts (the plain zoom-SELECT band).
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;

    const endPan = () => {
      const pan = panDragRef.current;
      if (!pan) return;
      panDragRef.current = null;
      setCtrlDragging(false); // WS6: pan ended → cursor back to 'grab' (Ctrl still held)
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      // Force a synchronous overscan reconcile of the FINAL window (the live `zoom`
      // already tracked the drag; this tops up the loaded superset for the rest spot).
      const w = curWindowRef.current;
      applyNavWindow({ fromMs: w.fromMs, toMs: w.toMs }, true);
    };

    const onMove = (e: MouseEvent) => {
      const pan = panDragRef.current;
      if (!pan) return;
      const deltaPx = e.clientX - pan.startClientX;
      const startSpan = pan.toMs - pan.fromMs;
      // "Grab the plot": drag right (deltaPx > 0) reveals EARLIER time → window LEFT,
      // hence the negation. Anchored to the START window + START pixel → no feedback.
      const deltaMs = -pixelPanDeltaMs(deltaPx, pan.plotWidthPx, startSpan);
      const next = panWindow(pan.fromMs, pan.toMs, deltaMs, boundsFromMs, boundsToMs);
      applyNavWindow(next); // live domain updates immediately; reconcile is debounced
    };

    const onUp = () => endPan();

    const onDown = (e: MouseEvent) => {
      // Only a PRIMARY-button Ctrl(/Cmd)+drag starts a pan; everything else (plain
      // drag, right-click) is left to Recharts' handlers (the zoom-SELECT band).
      if (e.button !== 0) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      if (!boundsValid) return;
      ctrlDownRef.current = true; // keep Ctrl tracking fresh
      // Plot pixel width = measured body width − the non-plot horizontal insets
      // (YAxis width + left/right margins). Guard against a zero/negative width.
      const rect = el.getBoundingClientRect();
      const plotWidthPx = rect.width - PLOT_X_INSET;
      if (!(plotWidthPx > 0)) return;
      const w = curWindowRef.current;
      panDragRef.current = {
        startClientX: e.clientX,
        fromMs: w.fromMs,
        toMs: w.toMs,
        plotWidthPx,
      };
      setCtrlDragging(true); // WS6: cursor → 'grabbing' while the pan is live
      // Suppress text-selection / Recharts' band for this gesture; track on the
      // DOCUMENT so a drag that leaves the chart body keeps panning until mouseup.
      e.preventDefault();
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    };

    el.addEventListener('mousedown', onDown);
    return () => {
      el.removeEventListener('mousedown', onDown);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [boundsValid, boundsFromMs, boundsToMs, applyNavWindow, bodyRef, curWindowRef]);

  const onBodyMouseEnter = useCallback(() => setHovering(true), []);
  const onBodyMouseLeave = useCallback(() => setHovering(false), []);

  return {
    focused,
    setFocused,
    chartCursor,
    hoverTsRef,
    panDragRef,
    ctrlDownRef,
    onBodyMouseEnter,
    onBodyMouseLeave,
  };
}
