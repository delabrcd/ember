// Placement migration/merge + structural equality (split out of the former
// monolithic lib/layoutEngine.ts, issue #157). PURE — no React / RGL / DOM.

import type { Breakpoint, Placement, Placements } from './placements';

// ---------------------------------------------------------------------------
// Placement migration — the saved-blob safety net (RFC §6).
// ---------------------------------------------------------------------------
//
// A saved `layouts` blob can drift: a widget the user removed, a widget added
// since they saved (a new chart, a new stat card), or garbage. mergePlacements
// repairs each breakpoint against a freshly-generated default, the same
// drop-unknown / append-new discipline mergeOrder/mergeDashboardLayout use:
//   • keep a saved placement only if its widget id is still known (in the default
//     for that breakpoint),
//   • APPEND any known widget the save is missing, at the position the default
//     generator put it (so a newly-added chart shows up placed, not lost),
//   • a missing/garbage breakpoint falls back to the full default.
// PURE — unit-tested.
export function mergePlacements(saved: unknown, def: Placements): Placements {
  const out: Placements = {};
  for (const bp of Object.keys(def) as Breakpoint[]) {
    let savedBp = readSavedBp(saved, bp);
    // #110 migration: a saved xs layout where EVERY tile is x=0,w=1 is the legacy
    // single-column stack (COLS.xs was 1, so no other arrangement was possible — it
    // can't be a deliberate customization). Discard it so the 2-up generateXs default
    // applies. The new default places charts/panels at w=2, so a current/2-up xs
    // layout never matches this signature → real customizations are preserved.
    if (bp === 'xs' && savedBp.length > 0 && savedBp.every((p) => p.x === 0 && p.w === 1)) {
      savedBp = [];
    }
    out[bp] = mergeOneBreakpoint(savedBp, def[bp] ?? []);
  }
  return out;
}

// Pull a saved breakpoint's placement array out of an untrusted blob, keeping
// only well-formed items (an `i` string + numeric x/y/w/h). Anything else is
// dropped here so mergeOneBreakpoint only sees plausible placements.
function readSavedBp(saved: unknown, bp: Breakpoint): Placement[] {
  if (!saved || typeof saved !== 'object') return [];
  const arr = (saved as Record<string, unknown>)[bp];
  if (!Array.isArray(arr)) return [];
  return arr.filter(isPlacement);
}

function isPlacement(v: unknown): v is Placement {
  if (!v || typeof v !== 'object') return false;
  const p = v as Record<string, unknown>;
  return (
    typeof p.i === 'string' &&
    typeof p.x === 'number' &&
    typeof p.y === 'number' &&
    typeof p.w === 'number' &&
    typeof p.h === 'number'
  );
}

// Merge one breakpoint: keep saved placements for still-known widgets (with
// their user-edited x/y/w/h), then append any known widget the save lacks at its
// default placement. Unknown saved ids (a removed/renamed widget) are dropped.
//
// SELF-HEAL (issue #73): a layout PERSISTED by the buggy generator can carry a
// sub-min `w`/`h` (the crushed stat cards). We repair each kept placement against
// the freshly-generated default's min for that widget — clamping `w`/`h` UP to the
// default's minW/minH and stamping those mins — so an existing dev/staging layout
// on the crushed default heals on the next merge without a factory reset. This is
// SAFE: it only ever GROWS a tile to a floor RGL would itself enforce on the first
// resize (it never shrinks a user's deliberate larger size, never moves x/y), and
// it's a no-op once the layout already satisfies the mins (idempotent). When the
// default carries no min (a registry-free caller), nothing is clamped.
function mergeOneBreakpoint(saved: Placement[], def: Placement[]): Placement[] {
  const defByI = new Map(def.map((p) => [p.i, p]));
  const kept = saved.filter((p) => defByI.has(p.i)).map((p) => healMins(p, defByI.get(p.i)!));
  const have = new Set(kept.map((p) => p.i));
  const appended = def.filter((p) => !have.has(p.i));
  return [...kept, ...appended];
}

// Clamp a saved placement up to the default's min bounds (and stamp those mins),
// leaving a placement that already meets them untouched. Only grows; never shrinks
// or moves. PURE.
function healMins(saved: Placement, def: Placement): Placement {
  let out = saved;
  if (typeof def.minW === 'number' && (out.minW !== def.minW || out.w < def.minW)) {
    out = { ...out, minW: def.minW, w: Math.max(out.w, def.minW) };
  }
  if (typeof def.minH === 'number' && (out.minH !== def.minH || out.h < def.minH)) {
    out = { ...out, minH: def.minH, h: Math.max(out.h, def.minH) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Structural equality — the Customize-mode persist guard (issue #73 fix).
// ---------------------------------------------------------------------------
//
// RGL fires `onLayoutChange` for NON-user reasons too (mount, breakpoint switch,
// vertical compaction, and — critically — any prop-driven `layouts` change we
// feed it). In Customize mode the component persists from that handler, which
// updates state, which re-feeds RGL, which fires `onLayoutChange` again: a
// feedback loop that only terminates if the fed-back layout equals what we just
// persisted. The transform pipeline (merge → rebase → clamp → sanitize) is NOT
// a guaranteed fixed point, so the loop never converged → React #185 ("maximum
// update depth exceeded"). The robust break (how RGL apps normally persist):
// only `onPlacementsChange` when the new layout STRUCTURALLY DIFFERS from what's
// already persisted — a no-op change can't trigger another persist→render cycle.
//
// We compare the placement GEOMETRY only (i/x/y/w/h, plus minW/minH when set),
// order-independent per breakpoint (keyed by `i`), so a re-emit that merely
// reorders the array or restamps RGL's transient `moved`/`static` fields reads
// as equal. PURE — hand-calc unit-tested.

// Canonicalize one placement to just its serializable, order-stable geometry, so
// two placements with the same box compare equal regardless of extra RGL stamps
// or key order. minW/minH are only included when present (mirrors `sanitize`).
function canonPlacement(p: Placement): string {
  const min = `${p.minW ?? ''},${p.minH ?? ''}`;
  return `${p.i}:${p.x},${p.y},${p.w},${p.h}:${min}`;
}

// Are two breakpoint placement arrays the same SET of boxes (order-independent)?
// Keyed by widget id so a re-emit in a different array order still matches.
function bpEqual(a: Placement[], b: Placement[]): boolean {
  if (a.length !== b.length) return false;
  const map = new Map(a.map((p) => [p.i, canonPlacement(p)]));
  for (const p of b) {
    if (map.get(p.i) !== canonPlacement(p)) return false;
  }
  return true;
}

// Do two Placements blobs describe the SAME layout across every breakpoint? Used
// to bail out of the Customize-mode persist when RGL re-emits a layout identical
// to the one already in state (the infinite-render-loop fix, issue #73). A
// breakpoint present-but-empty on one side and absent on the other counts as
// equal (both render nothing there). PURE — hand-calc unit-tested.
export function placementsEqual(a: Placements, b: Placements): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<Breakpoint>;
  for (const bp of keys) {
    if (!bpEqual(a[bp] ?? [], b[bp] ?? [])) return false;
  }
  return true;
}
