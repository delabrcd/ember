'use client';

// Spacer widget renderer (CHANGE 2, issue #73). A spacer is a resizable/draggable
// tile that HOLDS a grid cell like any panel but is visually empty in view mode —
// it exists only to create intentional spacing in the compacting grid (now that the
// grid packs gaps away, a deliberate gap must be a real placement that reserves its
// cell). Multiple spacers coexist as `spacer:1`, `spacer:2`, … (the registry
// resolves any `spacer:<n>` id to this one renderer; see registry.tsx).
//
// RENDER CONTRACT:
//   • view mode / not customizing → NOTHING visible (a transparent box that still
//     OCCUPIES its grid cell, so it reserves space and the tile after it doesn't
//     compact up into the gap).
//   • Customize mode → a faint dashed outline labelled "Spacer" so it's findable,
//     draggable, resizable and removable like any other tile.
// `h-full w-full` so it fills its placed grid cell either way. No data, no host use.
export function Spacer({ customizing }: { customizing: boolean }) {
  if (!customizing) {
    // View mode: occupy the cell but render nothing — the gap is held, invisibly.
    return <div className="h-full w-full" aria-hidden />;
  }
  // Customize mode: a faint dashed outline so the spacer is visible + editable.
  return (
    <div className="flex h-full w-full items-center justify-center rounded-2xl border border-dashed border-slate-500/40 bg-slate-500/5 text-[11px] uppercase tracking-wide text-slate-500/70">
      Spacer
    </div>
  );
}
