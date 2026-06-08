import { describe, expect, it } from 'vitest';
import {
  currentWinterStartYear,
  presetPair,
  winterSpan,
  ytdSpan,
} from '../src/lib/comparePresets';

describe('comparePresets window math (hand-calculated)', () => {
  describe('winterSpan + currentWinterStartYear', () => {
    it('winter span is Nov of the start year → Mar of the next', () => {
      expect(winterSpan(2024)).toEqual({ fromYm: 202411, toYm: 202503 });
      expect(winterSpan(2023)).toEqual({ fromYm: 202311, toYm: 202403 });
    });

    it('Nov/Dec belong to the winter starting that year', () => {
      expect(currentWinterStartYear(202411)).toBe(2024);
      expect(currentWinterStartYear(202412)).toBe(2024);
    });

    it('Jan–Mar belong to the winter that started the prior year', () => {
      expect(currentWinterStartYear(202501)).toBe(2024);
      expect(currentWinterStartYear(202503)).toBe(2024);
    });

    it('off-season (Apr–Oct) falls back to the most recently completed winter', () => {
      expect(currentWinterStartYear(202507)).toBe(2024); // summer 2025 → winter 2024
      expect(currentWinterStartYear(202504)).toBe(2024);
      expect(currentWinterStartYear(202510)).toBe(2024);
    });
  });

  describe('ytdSpan', () => {
    it('runs January through the given end month', () => {
      expect(ytdSpan(2025, 3)).toEqual({ fromYm: 202501, toYm: 202503 });
      expect(ytdSpan(2024, 12)).toEqual({ fromYm: 202401, toYm: 202412 });
    });
  });

  describe('presetPair', () => {
    it('trailing12: A is the 12 months ending at the anchor, B the 12 before', () => {
      // anchor Mar 2025 (202503): A = Apr 2024 → Mar 2025; B = Apr 2023 → Mar 2024.
      expect(presetPair('trailing12', 202503)).toEqual({
        a: { fromYm: 202404, toYm: 202503 },
        b: { fromYm: 202304, toYm: 202403 },
      });
    });

    it('trailing12 rolls across the year boundary correctly', () => {
      // anchor Dec 2024: A = Jan–Dec 2024; B = Jan–Dec 2023.
      expect(presetPair('trailing12', 202412)).toEqual({
        a: { fromYm: 202401, toYm: 202412 },
        b: { fromYm: 202301, toYm: 202312 },
      });
    });

    it('winter: this winter (Nov–Mar) vs last winter, one year earlier', () => {
      // anchor Mar 2025 → winter 2024 (Nov24–Mar25) vs winter 2023 (Nov23–Mar24).
      expect(presetPair('winter', 202503)).toEqual({
        a: { fromYm: 202411, toYm: 202503 },
        b: { fromYm: 202311, toYm: 202403 },
      });
    });

    it('ytd: Jan→anchor-month this year vs Jan→same month last year', () => {
      // anchor Mar 2025 → Jan–Mar 2025 vs Jan–Mar 2024 (equal length).
      expect(presetPair('ytd', 202503)).toEqual({
        a: { fromYm: 202501, toYm: 202503 },
        b: { fromYm: 202401, toYm: 202403 },
      });
    });

    it('custom returns null (the component owns both windows)', () => {
      expect(presetPair('custom', 202503)).toBeNull();
    });
  });
});
