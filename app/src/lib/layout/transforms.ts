// Pure placement-blob transforms lifted out of the components (issue #157, §2 —
// these are testable array transforms that were inlined in Dashboard.tsx and
// WidgetLayout.tsx). They take the current layout blob + the registry-derived
// data the component supplies (sizes/mins/ids — never imported here, so this
// module stays pure: no React / RGL / DOM / registry dependency) and return a new
// `Placements`. The components call them and `setPlacements(result)` / feed the
// result to RGL.
//
// CRITICAL (issue #157): these preserve the persisted-layout JSON shape and the
// keep-known / append-new / drop-unknown merge semantics EXACTLY — they are a
// mechanical extraction of the prior inline code, not a behavioural change.

import { COLS, readStrip, withStrip, type Breakpoint, type Placement, type Placements } from './placements';
import { findFreeSlot, paginatePlacements } from './pagination';

// A widget's grid box prototype, as the registry's `defaultSize` exposes it.
export interface WidgetBox {
  w: number;
  h: number;
  minW?: number;
  minH?: number;
}

// ---------------------------------------------------------------------------
// Dashboard.tsx add/remove/spacer/pin transforms (§2 lift).
// ---------------------------------------------------------------------------

// Remove a widget type from every saved breakpoint. When no layout is saved yet
// (`cur` undefined), materialize the supplied default lg set MINUS the type so the
// removal sticks (the other breakpoints regenerate from WidgetLayout's defaults).
// `fitBp` is the fit breakpoint key. PURE.
export function removeFromPlacements(
  cur: Placements | undefined,
  type: string,
  materializedLg: Placement[],
  fitBp: Breakpoint
): Placements {
  if (!cur) {
    return { [fitBp]: materializedLg.filter((p) => p.i !== type) };
  }
  const next: Record<string, Placement[]> = {};
  for (const bp of Object.keys(cur) as Breakpoint[]) {
    const arr = cur[bp];
    if (Array.isArray(arr)) next[bp] = arr.filter((p) => p.i !== type);
  }
  return next;
}

// Add a widget type to the saved lg page grid at its first free slot (the other
// breakpoints pick it up via WidgetLayout's merge against fresh defaults). Returns
// `null` when nothing changes — no layout saved yet (already shown) or the type is
// already placed at lg — so the caller can skip the persist. PURE.
export function addToPlacements(
  cur: Placements | undefined,
  type: string,
  defaultSize: WidgetBox,
  fitBp: Breakpoint
): Placements | null {
  if (!cur) return null; // nothing removed yet → already shown
  const lg = Array.isArray(cur[fitBp]) ? cur[fitBp]! : [];
  if (lg.some((p) => p.i === type)) return null; // already placed
  const next: Record<string, Placement[]> = { ...(cur as Record<string, Placement[]>) };
  // Drop at the widget's registry default size on the FIRST free slot of the lg
  // grid (findFreeSlot scans reading-order for the first non-overlapping cell).
  const slot = findFreeSlot(lg, defaultSize, COLS[fitBp]);
  next[fitBp] = [
    { i: type, x: slot.x, y: slot.y, w: defaultSize.w, h: defaultSize.h, minW: defaultSize.minW, minH: defaultSize.minH },
    ...lg,
  ];
  return next;
}

// Add a NEW spacer instance (CHANGE 2). Spacers are multi-instance and always
// addable, so the caller mints a FRESH id and supplies it (+ its registry box).
// We drop it at a free lg slot. When no layout is saved yet the caller supplies
// the materialized current default as `lgBase` so the spacer sticks as an explicit
// placement. The pinned strip is carried through untouched. PURE.
export function addSpacer(
  cur: Placements | undefined,
  newId: string,
  defaultSize: WidgetBox,
  lgBase: Placement[],
  fitBp: Breakpoint
): Placements {
  const lg = Array.isArray(cur?.[fitBp]) ? cur![fitBp]! : lgBase;
  const slot = findFreeSlot(lg, defaultSize, COLS[fitBp]);
  const newTile: Placement = {
    i: newId,
    x: slot.x,
    y: slot.y,
    w: defaultSize.w,
    h: defaultSize.h,
    minW: defaultSize.minW,
    minH: defaultSize.minH,
  };
  // Preserve any other saved breakpoints + the strip; only the lg page grid gains
  // the new spacer (other breakpoints pick it up via WidgetLayout's merge defaults).
  const next: Record<string, Placement[]> = cur ? { ...(cur as Record<string, Placement[]>) } : {};
  next[fitBp] = [newTile, ...lg];
  const strip = readStrip(cur ?? undefined);
  return strip ? withStrip(next as Record<Breakpoint, Placement[]>, strip) : next;
}

// Pin / unpin a widget to the top bar (issue #73 polish #4). Edits the SAME layout
// blob (no schema change): pinning adds the widget's placement to __strip (at a
// free strip slot) and DROPS it from every page breakpoint; unpinning removes it
// from __strip and re-adds it to a free page slot at each breakpoint.
//
// The caller supplies the materialized current strip + the full per-breakpoint
// page default (used when nothing is saved yet) so this stays pure + registry-free.
// PURE.
export function togglePin(
  cur: Placements | undefined,
  type: string,
  opts: {
    curStrip: Placement[]; // the effective current strip (saved or migration default)
    fullDefault: Placements; // freshly generated default for the full available set
    defaultSize: WidgetBox; // the widget's registry box
    stripSize: { w: number; h: number }; // the COMPACT size it takes when pinned
    stripCols: number; // the strip grid's column count
  }
): Placements {
  const { curStrip, fullDefault, defaultSize, stripSize, stripCols } = opts;
  // The page breakpoints: the saved blob if present, else the freshly generated
  // default for the full available set (so a never-customized layout still gets a
  // complete set of page placements to move the widget between).
  const pageBlob: Record<string, Placement[]> = {};
  for (const bp of Object.keys(COLS) as Breakpoint[]) {
    const saved = cur?.[bp];
    pageBlob[bp] = Array.isArray(saved) ? [...saved] : (fullDefault[bp] ?? []);
  }

  const isPinned = curStrip.some((p) => p.i === type);
  let nextStrip: Placement[];
  if (isPinned) {
    // UNPIN: drop from the strip, then ensure it has a page placement to return
    // to at every breakpoint (a free slot if it's missing there).
    nextStrip = curStrip.filter((p) => p.i !== type);
    for (const bp of Object.keys(COLS) as Breakpoint[]) {
      const arr = pageBlob[bp]!;
      if (arr.some((p) => p.i === type)) continue; // already has a page slot
      const slot = findFreeSlot(arr, defaultSize, COLS[bp]);
      arr.unshift({
        i: type,
        x: slot.x,
        y: slot.y,
        w: Math.min(defaultSize.w, COLS[bp]),
        h: defaultSize.h,
        minW: defaultSize.minW,
        minH: defaultSize.minH,
      });
    }
  } else {
    // PIN: add to the strip at a free slot (a COMPACT strip size so a pinned
    // chart/panel doesn't make the bar viewport-tall — the strip is a thin band).
    // Then drop the widget from every page breakpoint so it lives ONLY in the bar.
    const slot = findFreeSlot(curStrip, stripSize, stripCols);
    nextStrip = [
      ...curStrip,
      {
        i: type,
        x: slot.x,
        y: slot.y,
        w: stripSize.w,
        h: stripSize.h,
        minW: defaultSize.minW,
        minH: defaultSize.minH,
      },
    ];
    for (const bp of Object.keys(COLS) as Breakpoint[]) {
      pageBlob[bp] = pageBlob[bp]!.filter((p) => p.i !== type);
    }
  }

  return withStrip(pageBlob as Record<Breakpoint, Placement[]>, nextStrip);
}

// ---------------------------------------------------------------------------
// WidgetLayout.tsx array transforms (§2 lift).
// ---------------------------------------------------------------------------

// Clamp wrapper that no-ops on an empty grid (paginatePlacements handles non-empty
// via clampToPages; we re-derive the clamped set here for the persisted blob + the
// fed layout so they agree). PURE.
export function clampToPagesSafe(placements: Placement[], rowsPerPage: number): Placement[] {
  if (placements.length === 0) return placements;
  // Reuse the engine's partition then flatten (it clamps internally), so a single
  // source of truth governs both the view partition and the persisted geometry.
  return paginatePlacements(placements, rowsPerPage).flat();
}

// SPACER fold (WidgetLayout :208-233). Spacers aren't produced by the default
// generator, so fold each placed spacer's SAVED geometry (or, missing, a free-slot
// fallback at its prototype size) into every breakpoint's defaults — this is what
// lets mergePlacements PRESERVE spacers (it keeps only ids present in the default;
// without this a spacer would be dropped on the next repair). The saved geometry is
// authoritative when present so a moved/resized spacer round-trips. Returns `base`
// unchanged when there are no spacers. PURE.
export function foldSpacerDefaults(
  base: Placements,
  spacerIds: string[],
  savedPlacements: Placements | undefined,
  spacerSize: WidgetBox
): Placements {
  if (spacerIds.length === 0) return base;
  const out: Placements = { ...base };
  for (const key of Object.keys(COLS) as Breakpoint[]) {
    const arr = [...(base[key] ?? [])];
    const cols = COLS[key];
    const savedArr = savedPlacements?.[key] ?? [];
    for (const id of spacerIds) {
      const saved = savedArr.find((p) => p.i === id);
      if (saved) {
        arr.push({ ...saved, minW: spacerSize.minW, minH: spacerSize.minH });
      } else {
        const slot = findFreeSlot(arr, spacerSize, cols);
        arr.push({
          i: id,
          x: slot.x,
          y: slot.y,
          w: Math.min(spacerSize.w, cols),
          h: spacerSize.h,
          minW: spacerSize.minW,
          minH: spacerSize.minH,
        });
      }
    }
    out[key] = arr;
  }
  return out;
}

// STRIP REPAIR (WidgetLayout :410-437). Repair the strip source (saved __strip, or
// the migration default the caller passes) against the placed universe — a pinned
// widget must still be a placed, available widget (its page-grid counterpart was
// removed → drop the pin too) — and stamp/lift each kept tile to its registry min
// floor so a SAVED strip persisted by the buggy generator self-heals. The caller
// supplies the source array (already chosen: saved ?? default) and a `boxOf` lookup
// for each id's registry box, keeping this pure + registry-free. PURE.
export function repairStrip(
  source: Placement[],
  placedIds: string[],
  boxOf: (id: string) => WidgetBox
): Placement[] {
  const known = new Set(placedIds);
  const kept = source.filter((p) => known.has(p.i));
  return kept.map((p) => {
    const box = boxOf(p.i);
    return {
      ...p,
      minW: box.minW,
      minH: box.minH,
      w: Math.max(p.w, box.minW ?? p.w),
      h: Math.max(p.h, box.minH ?? p.h),
    };
  });
}

// PERSIST-BLOB BUILD (WidgetLayout :647-678). Build the persistable per-breakpoint
// blob from RGL's already-sanitized per-breakpoint arrays, applying the
// pinned-widget fold-back and the paged clamp (the same transform the fed layout
// uses, so the persisted geometry and the view-mode partition agree).
//
// The caller hands in the sanitized arrays keyed by breakpoint (`sanitizedByBp`),
// plus the deps that decide the folds: the prior merged `layouts` (for the pinned
// tiles' saved page geometry), the `pinnedIds` set, the `gridIds` (paged) list,
// `rowsPerPage`, the `fitBp`, and flags `pinActive`/`fitActive`. The pinned strip
// is carried through untouched from `savedStrip` (read off the saved blob, the
// authority). PURE.
export function buildPersistBlob(opts: {
  sanitizedByBp: Partial<Record<Breakpoint, Placement[]>>;
  layouts: Placements;
  pinnedIds: Set<string>;
  gridIds: string[];
  rowsPerPage: number;
  fitBp: Breakpoint;
  pinActive: boolean;
  fitActive: boolean;
  savedStrip: Placement[] | undefined;
}): Placements {
  const { sanitizedByBp, layouts, pinnedIds, gridIds, rowsPerPage, fitBp, pinActive, fitActive, savedStrip } = opts;
  const next: Placements = {};
  for (const key of Object.keys(COLS) as Breakpoint[]) {
    const arr = sanitizedByBp[key];
    if (!Array.isArray(arr)) continue;
    let edited = arr;
    // At lg, when the strip is shown, the grid excluded the PINNED tiles — fold
    // their existing saved page placements back so the persisted lg blob stays
    // complete (so unpinning, and md/sm/xs, keep each widget's page geometry).
    if (key === fitBp && pinActive) {
      const prevLg = layouts[fitBp] ?? [];
      const pinned = prevLg.filter((p) => pinnedIds.has(p.i));
      edited = [...pinned, ...edited];
    }
    // Clamp the edited lg grid to pages so a tile dragged across a boundary in
    // the (scrolling) customize canvas is re-banded — keeping the view-mode
    // partition straddle-free. Only the paged (lg, fit) breakpoint is clamped.
    if (key === fitBp && fitActive) {
      const grid = edited.filter((p) => gridIds.includes(p.i));
      const rest = edited.filter((p) => !gridIds.includes(p.i));
      edited = [...rest, ...clampToPagesSafe(grid, rowsPerPage)];
    }
    next[key] = edited;
  }
  // Carry the pinned strip's placements through a PAGE-grid persist untouched —
  // they ride the same blob under STRIP_KEY (issue #73 polish #4) and a page edit
  // must not drop them.
  return savedStrip ? withStrip(next, savedStrip) : next;
}
