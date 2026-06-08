// Compare-periods preset → window math (issue #47, the interactive Compare tool).
// PURE — no DB, browser, or React. Each preset maps an anchor ym (the latest data
// month) to two inclusive {fromYm,toYm} windows: A (the recent period) and B (the
// comparison period). The component slices the loaded series to each window and
// hands the two row-sets to the pure compareYoY; all the period math lives here so
// it's hand-calculable in tests. Unit-tested in test/comparePresets.test.ts.

import { ymAddMonths } from './ym';

export interface CompareWindow {
  fromYm: number;
  toYm: number;
}

export interface ComparePair {
  a: CompareWindow;
  b: CompareWindow;
}

// The selectable comparison modes. 'custom' has no preset math — the component
// drives both windows from its two range pickers — so it's intentionally absent
// from PRESET_PAIR below (presetPair returns null for it).
export type ComparePreset = 'trailing12' | 'winter' | 'ytd' | 'custom';

export const COMPARE_PRESETS: { value: ComparePreset; label: string }[] = [
  { value: 'trailing12', label: 'Trailing 12 mo vs prior 12 mo' },
  { value: 'winter', label: 'This winter vs last winter' },
  { value: 'ytd', label: 'YTD vs last YTD' },
  { value: 'custom', label: 'Custom…' },
];

// Heating-season span used by the "winter" preset: November through the following
// March (5 months). A winter is identified by the calendar year it STARTS in, so
// "winter 2024" = Nov 2024 → Mar 2025. PURE.
export const WINTER_START_MONTH = 11; // November
export const WINTER_END_MONTH = 3; // March (of the following year)
export const WINTER_LENGTH_MONTHS = 5; // Nov, Dec, Jan, Feb, Mar

// The Nov–Mar window for the winter that STARTS in `startYear` (e.g. 2024 →
// { 202411, 202503 }). PURE.
export function winterSpan(startYear: number): CompareWindow {
  return { fromYm: startYear * 100 + WINTER_START_MONTH, toYm: (startYear + 1) * 100 + WINTER_END_MONTH };
}

// Which winter is "current" for an anchor ym: the heating season that anchor
// falls in. Nov/Dec belong to the winter starting that year; Jan–Mar belong to
// the winter that started the PRIOR year; Apr–Oct (off-season) fall back to the
// most recently COMPLETED winter (the one that started the prior year). Returns
// the winter's start year. PURE.
export function currentWinterStartYear(anchorYm: number): number {
  const year = Math.floor(anchorYm / 100);
  const month = anchorYm % 100;
  // In the active heating season's first leg (Nov/Dec): this year's winter.
  if (month >= WINTER_START_MONTH) return year;
  // Otherwise (Jan–Oct) the most recent winter started the previous year.
  return year - 1;
}

// Year-to-date span: January of `year` through the anchor's month. PURE. For a
// prior-year YTD we use the SAME end month so the two windows are equal length
// (e.g. anchor Mar 2025 → this YTD Jan–Mar 2025, last YTD Jan–Mar 2024).
export function ytdSpan(year: number, endMonth: number): CompareWindow {
  return { fromYm: year * 100 + 1, toYm: year * 100 + endMonth };
}

// Map a preset + anchor ym to its A/B window pair. Returns null for 'custom'
// (the component owns both windows directly) — and never throws. PURE.
//
//   trailing12 → A = the 12 months ending at the anchor; B = the 12 before that.
//   winter     → A = this winter (Nov–Mar); B = last winter, one year earlier.
//   ytd        → A = Jan→anchor-month this year; B = Jan→same month last year.
export function presetPair(preset: ComparePreset, anchorYm: number): ComparePair | null {
  switch (preset) {
    case 'trailing12': {
      const aFrom = ymAddMonths(anchorYm, -11);
      const bTo = ymAddMonths(anchorYm, -12);
      const bFrom = ymAddMonths(bTo, -11);
      return { a: { fromYm: aFrom, toYm: anchorYm }, b: { fromYm: bFrom, toYm: bTo } };
    }
    case 'winter': {
      const startYear = currentWinterStartYear(anchorYm);
      return { a: winterSpan(startYear), b: winterSpan(startYear - 1) };
    }
    case 'ytd': {
      const year = Math.floor(anchorYm / 100);
      const month = anchorYm % 100;
      return { a: ytdSpan(year, month), b: ytdSpan(year - 1, month) };
    }
    case 'custom':
    default:
      return null;
  }
}
