import { describe, expect, it } from 'vitest';
import { sumDegreeDays } from '../src/lib/weather/degreeDays';

describe('sumDegreeDays (hand-calculated)', () => {
  it('splits each day into HDD/CDD against the base', () => {
    // base 65: 60°F -> HDD 5, CDD 0; 65°F -> HDD 0, CDD 0; 75°F -> HDD 0, CDD 10.
    const r = sumDegreeDays(
      [
        { date: '2026-01-01', tMean: 60 },
        { date: '2026-01-02', tMean: 65 },
        { date: '2026-01-03', tMean: 75 },
      ],
      65
    );
    expect(r.hdd).toBe(5); // 5 + 0 + 0
    expect(r.cdd).toBe(10); // 0 + 0 + 10
    expect(r.days).toBe(3);
  });

  it('defaults the base to 65°F', () => {
    // 50°F -> HDD 15; 80°F -> CDD 15.
    const r = sumDegreeDays([
      { date: '2026-02-01', tMean: 50 },
      { date: '2026-02-02', tMean: 80 },
    ]);
    expect(r.hdd).toBe(15);
    expect(r.cdd).toBe(15);
    expect(r.days).toBe(2);
  });

  it('honors a non-default base', () => {
    // base 60: 40°F -> HDD 20; 70°F -> CDD 10; 60°F -> 0/0.
    const r = sumDegreeDays(
      [
        { date: '2026-03-01', tMean: 40 },
        { date: '2026-03-02', tMean: 70 },
        { date: '2026-03-03', tMean: 60 },
      ],
      60
    );
    expect(r.hdd).toBe(20);
    expect(r.cdd).toBe(10);
    expect(r.days).toBe(3);
  });

  it('is empty for no days', () => {
    expect(sumDegreeDays([])).toEqual({ hdd: 0, cdd: 0, days: 0 });
  });
});
