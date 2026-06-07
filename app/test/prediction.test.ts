import { describe, expect, it } from 'vitest';
import {
  computeNextCheck,
  estimateNextBill,
  intervalSpreadDays,
  medianIntervalDays,
  predictNextBill,
  predictionWindow,
  SPARSE_GAP_DAYS,
} from '../src/lib/prediction';
import type { MonthRow } from '../src/lib/chartSpec';

const D = (s: string) => new Date(s + 'T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (d: Date) => d.toISOString().slice(0, 10);

// Build a MonthRow with sensible nulls, then derive the all-in cost/rate fields
// from kwh/therms at fixed unit prices so trailing12AllIn() is exactly known:
// elec all-in = $0.20/kWh, gas all-in = $1.00/therm. billTotal is set explicitly.
function row(p: { ym: number; kwh?: number | null; therms?: number | null; billTotal?: number | null }): MonthRow {
  const kwh = p.kwh ?? null;
  const therms = p.therms ?? null;
  const elecBill = kwh != null ? +(kwh * 0.2).toFixed(6) : null;
  const gasBill = therms != null ? +(therms * 1.0).toFixed(6) : null;
  return {
    ym: p.ym,
    label: `${Math.floor(p.ym / 100)}-${String(p.ym % 100).padStart(2, '0')}`,
    kwh,
    therms,
    elecSupply: null, gasSupply: null, elecDelivery: null, gasDelivery: null,
    elecBill, gasBill,
    elecRateSupply: null, gasRateSupply: null,
    elecRateAllIn: null, gasRateAllIn: null,
    avgTemp: null,
    billTotal: p.billTotal ?? null,
    hdd: null, cdd: null, kwhPerDegreeDay: null, thermsPerHdd: null,
  };
}

describe('medianIntervalDays (hand-calculated)', () => {
  it('takes the median of consecutive gaps', () => {
    // gaps: 01-01->01-31 = 30, 01-31->03-03 = 31, 03-03->04-01 = 29
    // sorted [29,30,31] -> median 30
    expect(medianIntervalDays([D('2026-01-01'), D('2026-01-31'), D('2026-03-03'), D('2026-04-01')])).toBe(30);
  });
  it('averages the two middle gaps for an even count', () => {
    // dates a..d give 3 gaps... use 5 dates for 4 gaps: 10,20,30,40 -> median (20+30)/2 = 25
    expect(
      medianIntervalDays([D('2026-01-01'), D('2026-01-11'), D('2026-01-31'), D('2026-03-02'), D('2026-04-11')])
    ).toBe(25);
  });
  it('defaults to ~30 days with fewer than two dates', () => {
    expect(medianIntervalDays([D('2026-01-01')])).toBe(30);
  });
});

describe('predictNextBill (hand-calculated)', () => {
  it('predicts last statement + median interval', () => {
    // gaps 30, 30 -> median 30; last = 03-02; +30d = 04-01
    const { predicted, medianDays } = predictNextBill([D('2026-01-01'), D('2026-01-31'), D('2026-03-02')]);
    expect(medianDays).toBe(30);
    expect(iso(predicted!)).toBe('2026-04-01');
  });
  it('returns null with no history', () => {
    expect(predictNextBill([]).predicted).toBeNull();
  });
});

describe('intervalSpreadDays (hand-calculated)', () => {
  it('is 0 for a perfectly regular biller', () => {
    // gaps all 30 -> MAD 0
    expect(intervalSpreadDays([D('2026-01-01'), D('2026-01-31'), D('2026-03-02'), D('2026-04-01')])).toBe(0);
  });
  it('is the MAD (median abs deviation) of the gaps', () => {
    // dates: +28,+30,+32,+30 -> gaps [28,30,32,30]
    //   median gap = sorted[28,30,30,32] -> (30+30)/2 = 30
    //   abs devs = [2,0,2,0] -> sorted [0,0,2,2] -> median (0+2)/2 = 1
    const dates = [D('2026-01-01'), D('2026-01-29'), D('2026-02-28'), D('2026-04-01'), D('2026-05-01')];
    expect(intervalSpreadDays(dates)).toBe(1);
  });
  it('is 0 with fewer than two gaps (cannot measure spread)', () => {
    expect(intervalSpreadDays([D('2026-01-01'), D('2026-01-31')])).toBe(0);
  });
});

describe('predictionWindow (hand-calculated)', () => {
  it('floors the half-width at MIN_WIGGLE (3d) for a regular biller', () => {
    // gaps all 30 -> medianInterval 30, spread 0 -> half = max(3, 2*0) = 3
    // last 04-01 -> predicted 05-01; window [04-28, 05-04]
    const w = predictionWindow([D('2026-01-01'), D('2026-01-31'), D('2026-03-02'), D('2026-04-01')]);
    expect(iso(w.predicted!)).toBe('2026-05-01');
    expect(iso(w.windowStart!)).toBe('2026-04-28');
    expect(iso(w.windowEnd!)).toBe('2026-05-04');
  });
  it('scales the half-width with historical spread (k=2)', () => {
    // gaps [28,30,32,30] -> medianInterval 30, spread (MAD) 1 -> half = max(3, 2*1) = 3
    // (spread 1 still under the floor; bump spread to widen)
    // Use gaps with MAD 3: [24,30,36,30] -> median 30, devs [6,0,6,0] median 3 -> half max(3,6)=6
    //   dates: 01-01,+24=01-25,+30=02-24,+36=04-01,+30=05-01 -> predicted 05-01+30=05-31
    //   window [05-25, 06-06]
    const dates = [D('2026-01-01'), D('2026-01-25'), D('2026-02-24'), D('2026-04-01'), D('2026-05-01')];
    const w = predictionWindow(dates);
    expect(iso(w.predicted!)).toBe('2026-05-31');
    expect(iso(w.windowStart!)).toBe('2026-05-25');
    expect(iso(w.windowEnd!)).toBe('2026-06-06');
  });
  it('returns all-null with no history', () => {
    const w = predictionWindow([]);
    expect(w.predicted).toBeNull();
    expect(w.windowStart).toBeNull();
    expect(w.windowEnd).toBeNull();
  });
});

describe('computeNextCheck back-off (issue #27, hand-calculated)', () => {
  // Regular biller: gaps all 30 -> predicted 05-01, spread 0 -> window [04-28, 05-04].
  const history = [D('2026-01-01'), D('2026-01-31'), D('2026-03-02'), D('2026-04-01')];

  it('far before the window: single sparse re-check SPARSE_GAP_DAYS (7d) out', () => {
    // now 04-01, windowStart 04-28; now+7d = 04-08 < windowStart -> 04-08
    expect(iso(computeNextCheck(D('2026-04-01'), history))).toBe('2026-04-08');
  });
  it('just before the window: snaps to windowStart (does not overshoot it)', () => {
    // now 04-25, windowStart 04-28; now+7d = 05-02 > windowStart -> windowStart 04-28
    expect(iso(computeNextCheck(D('2026-04-25'), history))).toBe('2026-04-28');
  });
  it('inside the window: daily', () => {
    // now 04-29 >= windowStart 04-28 -> now + 1 day
    const now = D('2026-04-29');
    expect(computeNextCheck(now, history).getTime()).toBe(now.getTime() + DAY);
  });
  it('past the window with no new bill yet: still daily', () => {
    // now 05-10 > windowEnd 05-04, but no newer bill landed (history unchanged) -> daily
    const now = D('2026-05-10');
    expect(computeNextCheck(now, history).getTime()).toBe(now.getTime() + DAY);
  });
  it('first run / no history: checks soon (SPARSE_GAP_DAYS out)', () => {
    const now = D('2026-05-01');
    expect(computeNextCheck(now, []).getTime()).toBe(now.getTime() + SPARSE_GAP_DAYS * DAY);
  });
});

describe('estimateNextBill (hand-calculated)', () => {
  it('projects from the same calendar month last year and bands by ±1σ of recent costs', () => {
    // 13 monthly rows 2025-05 .. 2026-05. Every row prices at $0.20/kWh and
    // $1.00/therm (see row()), so trailing12AllIn -> exactly 0.20 and 1.00.
    // Latest usage row is 2026-05 (ym 202605) -> target period 2026-06 (202606).
    // Same month last year = 2025-06 (ym 202506), usage kwh=600, therms=40.
    //   point = 600 * 0.20 + 40 * 1.00 = 120 + 40 = 160.00
    // Band: sample stdev of the trailing-3 billTotal [150, 160, 170]:
    //   mean 160; var = (100 + 0 + 100) / (3-1) = 100; stdev = 10; k=1
    //   low = 160 - 10 = 150.00 ; high = 160 + 10 = 170.00
    const rows: MonthRow[] = [
      row({ ym: 202505, kwh: 500, therms: 50, billTotal: 100 }),
      row({ ym: 202506, kwh: 600, therms: 40, billTotal: 100 }), // same month last year
      row({ ym: 202507, kwh: 700, therms: 10, billTotal: 100 }),
      row({ ym: 202508, kwh: 700, therms: 5, billTotal: 100 }),
      row({ ym: 202509, kwh: 650, therms: 8, billTotal: 100 }),
      row({ ym: 202510, kwh: 600, therms: 20, billTotal: 100 }),
      row({ ym: 202511, kwh: 550, therms: 60, billTotal: 100 }),
      row({ ym: 202512, kwh: 520, therms: 90, billTotal: 100 }),
      row({ ym: 202601, kwh: 540, therms: 100, billTotal: 100 }),
      row({ ym: 202602, kwh: 530, therms: 95, billTotal: 100 }),
      row({ ym: 202603, kwh: 560, therms: 70, billTotal: 150 }), // trailing-3 cost
      row({ ym: 202604, kwh: 580, therms: 45, billTotal: 160 }), // trailing-3 cost
      row({ ym: 202605, kwh: 610, therms: 30, billTotal: 170 }), // latest usage + trailing-3 cost
    ];
    const est = estimateNextBill(rows);
    expect(est).not.toBeNull();
    expect(est!.point).toBeCloseTo(160.0, 6);
    expect(est!.low).toBeCloseTo(150.0, 6);
    expect(est!.high).toBeCloseTo(170.0, 6);
    expect(est!.basis).toContain('same month last year');
  });

  it('falls back to the trailing-N usage average and a ±15% band when there is no last-year month or cost spread', () => {
    // Only three rows, none a year before the target, and only ONE has billTotal
    // (so sample stdev is undefined -> ±15% fallback band).
    // Latest usage row 2026-05 (202605) -> target 2026-06 (202606); 202506 absent.
    // Trailing-3 usage avg: kwh (100+200+300)/3 = 200 ; therms (10+20+30)/3 = 20.
    //   point = 200 * 0.20 + 20 * 1.00 = 40 + 20 = 60.00
    //   band: stdev undefined (one cost sample) -> ±15% of 60 = 9
    //   low = 60 - 9 = 51.00 ; high = 60 + 9 = 69.00
    const rows: MonthRow[] = [
      row({ ym: 202603, kwh: 100, therms: 10, billTotal: 55 }),
      row({ ym: 202604, kwh: 200, therms: 20 }),
      row({ ym: 202605, kwh: 300, therms: 30 }),
    ];
    const est = estimateNextBill(rows);
    expect(est).not.toBeNull();
    expect(est!.point).toBeCloseTo(60.0, 6);
    expect(est!.low).toBeCloseTo(51.0, 6);
    expect(est!.high).toBeCloseTo(69.0, 6);
    expect(est!.basis).toContain('trailing 3-mo avg');
    expect(est!.basis).toContain('±15%');
  });

  it('returns null when there is no usable usage', () => {
    expect(estimateNextBill([])).toBeNull();
    expect(estimateNextBill([row({ ym: 202605, billTotal: 100 })])).toBeNull();
  });
});
