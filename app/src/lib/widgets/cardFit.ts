// Pure card-fit arithmetic (issue #73 content-fit; compact-stat-cards iteration).
// The operator's rule for the compact strip: a stat card's DEFAULT body is just
// its (brief) title + the headline value (plus the progress bar for the budget
// card) — the old sub/detail line moved into the ⓘ tooltip, so it no longer takes
// card space. This module owns the load-bearing PIXEL ARITHMETIC behind the card's
// minimum height: the height a card's ESSENTIAL content needs, which IS the whole
// body now (there's no optional detail line to hide). Kept here, NO React / DOM, so
// it's hand-calc unit-tested the same way the rest of lib/ is — and so the
// registry's grid `minH` derives from ONE set of numbers, not hand-tuned guesses
// scattered across files.
//
// The numbers are measured against the card's actual markup (StatCard.tsx) at the
// theme's type scale, with the COMPACT `!px-1.5 !py-2` padding. The card
// is border-box (Tailwind default), so a tile's px height must cover the card's
// 1px top + 1px bottom BORDER on top of its padding + content — otherwise the
// content area is 2px short and the headline clips by a hair (caught by the headless
// scrollHeight check). We fold that 2px in:
//   • card border (`.card`)            → 1px top + 1px bottom = 2px
//   • card padding (`!py-2`)           → 8px top + 8px bottom = 16px (the
//                                         horizontal `!px-1.5` doesn't affect height)
//   • title  (`card-title text-xs`)    → ~16px line box
//   • headline (`stat text-xl`)        → ~28px line box (the single UNIFORM size)
//   • progress bar (budget only)       → ~6px bar, NO extra reserve (see below)
// These are deliberately rounded UP a hair: erring toward a slightly taller floor
// is fine; letting content overflow the card is not.
//
// UNIFORM HEIGHT (visual-uniformity pass). The operator: "the budget one is a
// totally different vertical size than the rest." The fix is that EVERY strip card
// — budget included — shares ONE essential height, so the registry derives the SAME
// minH (and the same strip-row span) for all of them. The budget card's ~6px
// progress bar now fits WITHIN that shared height rather than reserving its own
// extra row: dropping the headline from text-2xl (32px) to the uniform text-xl
// (~28px) freed ~4px, and the band the simple card's minH=2 buys (2*30 + 8 = 68px
// of content vs. the 66px the title+headline need) leaves slack the bar slots into.
// So we no longer add a BAR_H term — budget's essential height EQUALS simple's, and
// `justify-between` in StatCard.tsx parks the bar at the card's bottom edge inside
// that shared height. Verified headlessly: the budget card's scrollHeight ≤ its
// clientHeight (no clip) and its rendered height equals the other strip cards'.

// One stat card's content geometry, in CSS px. `kind` is retained so callers stay
// explicit about which card they're sizing, but BOTH kinds now share the same
// essential height (the budget bar fits within the uniform band, not an extra row)
// — the visual-uniformity pass made the strip cards one height.
export type StatCardKind = 'simple' | 'budget';

const CARD_BORDER_Y = 2; // .card border → 1 top + 1 bottom (border-box)
const CARD_PADDING_Y = 16; // !py-2 → 8 top + 8 bottom (px axis is !px-1.5, height-irrelevant)
const TITLE_H = 16; // card-title text-xs
const HEADLINE_H = 32; // headline line box (text-xl ~28px, rounded up to the prior 32 floor for slack)

// The ESSENTIAL (border-box) height a card needs: border + padding + title +
// headline. With the detail line gone — and the budget bar now fitting WITHIN this
// shared height rather than reserving its own row — this IS the card's full content
// height for EVERY kind, so the registry derives ONE uniform `minH` (and one
// strip-row span) from it. A card can't be resized shorter than the height that fits
// title + headline without clipping; the budget bar rides along inside it.
export function essentialHeightPx(_kind: StatCardKind): number {
  return CARD_BORDER_Y + CARD_PADDING_Y + TITLE_H + HEADLINE_H;
}

// Convert an essential pixel height into a grid-ROW minimum for a given runtime
// rowHeight + RGL margin, so the registry's `minH` tracks the SAME content
// arithmetic. n rows span n*rowHeight + (n−1)*margin px of content (the inter-row
// margins inside a multi-row tile); we ceil so the rows always cover the required
// pixels. Clamped to ≥1. PURE — hand-calc unit-tested.
export function pxToMinRows(px: number, rowHeight: number, marginY: number): number {
  const rh = Math.max(1, rowHeight);
  // Solve n*rh + (n−1)*m ≥ px  →  n ≥ (px + m) / (rh + m).
  const n = Math.ceil((px + marginY) / (rh + marginY));
  return Math.max(1, n);
}
