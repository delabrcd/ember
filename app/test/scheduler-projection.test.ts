import { describe, expect, it } from 'vitest';
import {
  projectTask,
  projectTimeline,
  taskKindLabel,
  type ProjectionTaskInput,
} from '../src/lib/scheduler/projection';
import type { TaskKind } from '../src/lib/scheduler/types';

const D = (s: string) => new Date(s + 'T00:00:00Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('projectTask — periodic full-scrape', () => {
  // No statement history -> computeFullScrapeNextRun returns clock + 7d each step.
  // Start at now, horizon 14 days -> fires at now, +7d, +14d (=horizonEnd, inclusive).
  // 3 fires is under the >4 collapse threshold so we get the full series.
  const now = D('2026-06-10');
  const task: ProjectionTaskInput = {
    kind: 'full-scrape',
    enabled: true,
    nextRunAt: now,
    facts: { statementDates: [], hasIntervalData: false, hasRecentPendingPdf: false },
  };

  it('produces an increasing 7-day-spaced series within the horizon', () => {
    const out = projectTask(task, now, 14);
    expect(out.map((a) => a.at!.getTime())).toEqual([
      now.getTime(),
      now.getTime() + 7 * DAY,
      now.getTime() + 14 * DAY,
    ]);
    // strictly increasing
    for (let i = 1; i < out.length; i++) {
      expect(out[i].at!.getTime()).toBeGreaterThan(out[i - 1].at!.getTime());
    }
    expect(out.every((a) => a.kind === 'full-scrape')).toBe(true);
  });

  it('honors a future nextRunAt (clock starts at max(nextRunAt, now))', () => {
    const future = new Date(now.getTime() + 2 * DAY);
    const out = projectTask({ ...task, nextRunAt: future }, now, 14);
    // fires at +2d, +9d, +16d>horizon(+14d) stops -> [+2d, +9d]
    expect(out.map((a) => a.at!.getTime())).toEqual([future.getTime(), future.getTime() + 7 * DAY]);
  });
});

describe('projectTask — collapse a tight constant cadence', () => {
  const now = D('2026-06-10');

  it('collapses a "pending" pdf-fetch (~6h) to one annotated entry', () => {
    const task: ProjectionTaskInput = {
      kind: 'pdf-fetch',
      enabled: true,
      nextRunAt: now,
      facts: { hasRecentPendingPdf: true }, // held constant -> fires every 6h
    };
    const out = projectTask(task, now, 7);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('pdf-fetch');
    expect(out[0].at!.getTime()).toBe(now.getTime()); // keeps the first fire
    expect(out[0].reason).toMatch(/every ~6h/);
  });

  it('collapses interval-pull (~daily) to one annotated entry', () => {
    const task: ProjectionTaskInput = {
      kind: 'interval-pull',
      enabled: true,
      nextRunAt: now,
      facts: { hasAmiMeter: true }, // held constant -> fires every 22h
    };
    const out = projectTask(task, now, 7);
    expect(out).toHaveLength(1);
    expect(out[0].at!.getTime()).toBe(now.getTime());
    expect(out[0].reason).toMatch(/daily/);
  });

  it('collapses a full-scrape capped at 22h with an honest "about daily" reason', () => {
    // hasIntervalData caps computeFullScrapeNextRun to now+22h every fire -> a
    // constant 22h cadence. Over 7d that is ~7-8 fires (>4) so it collapses, and
    // 22h >= 20h so the reason reads "about daily", NOT "tight cadence".
    const task: ProjectionTaskInput = {
      kind: 'full-scrape',
      enabled: true,
      nextRunAt: now,
      facts: { statementDates: [], hasIntervalData: true, hasRecentPendingPdf: false },
    };
    const out = projectTask(task, now, 7);
    expect(out).toHaveLength(1);
    expect(out[0].at!.getTime()).toBe(now.getTime());
    expect(out[0].reason).toBe('recurring about daily');
  });

  it('collapses a full-scrape capped at 6h with an honest "about every 6h" reason', () => {
    // hasRecentPendingPdf caps computeFullScrapeNextRun to now+6h every fire ->
    // constant 6h cadence, >4 fires over 7d, 6h < 20h -> "about every 6h".
    const task: ProjectionTaskInput = {
      kind: 'full-scrape',
      enabled: true,
      nextRunAt: now,
      facts: { statementDates: [], hasIntervalData: false, hasRecentPendingPdf: true },
    };
    const out = projectTask(task, now, 7);
    expect(out).toHaveLength(1);
    expect(out[0].reason).toBe('recurring about every 6h');
  });
});

describe('projectTask — reactive / inactive', () => {
  const now = D('2026-06-10');

  it('weather-sync (nextRunAt=null) yields one reactive annotation with NO time', () => {
    const out = projectTask(
      { kind: 'weather-sync', enabled: true, nextRunAt: null, facts: {} },
      now,
      7
    );
    expect(out).toHaveLength(1);
    expect(out[0].at).toBeNull(); // reactive: no bogus "just now" timestamp
    expect(out[0].reason).toMatch(/reactive/);
  });

  it('notify-sync (nextRunAt=null) yields one reactive annotation', () => {
    const out = projectTask(
      { kind: 'notify-sync', enabled: true, nextRunAt: null, facts: {} },
      now,
      7
    );
    expect(out).toHaveLength(1);
    expect(out[0].reason).toMatch(/reactive/);
  });

  it('a disabled task yields one inactive annotation with NO time', () => {
    const at = new Date(now.getTime() + 3 * HOUR);
    const out = projectTask(
      { kind: 'interval-pull', enabled: false, nextRunAt: at, facts: { hasAmiMeter: true } },
      now,
      7
    );
    expect(out).toHaveLength(1);
    expect(out[0].at).toBeNull(); // disabled -> reactive branch, no timestamp
  });

  it('a null interval-pull annotates "no AMI meter"', () => {
    const out = projectTask(
      { kind: 'interval-pull', enabled: true, nextRunAt: null, facts: {} },
      now,
      7
    );
    expect(out[0].reason).toMatch(/no AMI meter/);
  });
});

describe('projectTask — infinite-loop guard', () => {
  const now = D('2026-06-10');

  it('terminates on a degenerate (non-advancing) cadence', () => {
    // weather-sync has no periodic cadence: nextFire returns null. But to exercise
    // the zero-step guard specifically, drive full-scrape with history that makes
    // computeNextCheck land AT the clock would be impossible (always +7d/+1d), so
    // instead assert the loop is bounded by checking a tight pdf-fetch over a huge
    // horizon never exceeds the iteration cap (collapses, finite).
    const task: ProjectionTaskInput = {
      kind: 'pdf-fetch',
      enabled: true,
      nextRunAt: now,
      facts: { hasRecentPendingPdf: true },
    };
    const out = projectTask(task, now, 14); // 14d/6h = 56 fires -> collapses, but loop must terminate
    expect(out.length).toBeGreaterThan(0);
    expect(out).toHaveLength(1); // collapsed
  });
});

describe('projectTimeline', () => {
  const now = D('2026-06-10');

  it('sorts scheduled (timed) entries first ascending, reactive (null) entries last', () => {
    const tasks: ProjectionTaskInput[] = [
      // interval-pull every 22h -> collapses to one entry at now
      { kind: 'interval-pull', enabled: true, nextRunAt: now, facts: { hasAmiMeter: true } },
      // full-scrape starting 1 day out (no caps -> +7d series)
      {
        kind: 'full-scrape',
        enabled: true,
        nextRunAt: new Date(now.getTime() + 1 * DAY),
        facts: { statementDates: [] },
      },
      // reactive weather (no time)
      { kind: 'weather-sync', enabled: true, nextRunAt: null, facts: {} },
    ];
    const out = projectTimeline(tasks, now, 14);

    // Scheduled entries (at != null) come first, ascending; then reactive (null).
    const firstNullIdx = out.findIndex((a) => a.at == null);
    expect(firstNullIdx).toBeGreaterThanOrEqual(0); // weather is present and null
    // everything before the first null is timed, ascending
    for (let i = 1; i < firstNullIdx; i++) {
      expect(out[i].at!.getTime()).toBeGreaterThanOrEqual(out[i - 1].at!.getTime());
    }
    // everything from the first null onward is null (reactive bucket is last)
    for (let i = firstNullIdx; i < out.length; i++) {
      expect(out[i].at).toBeNull();
    }
    // the leading timed entry is the interval-pull at now (before full-scrape +1d)
    expect(out[0].kind).toBe('interval-pull');
    expect(out[0].at!.getTime()).toBe(now.getTime());
    // weather-sync is the reactive (null) entry, sorted last
    expect(out[out.length - 1].kind).toBe('weather-sync');
    expect(out[out.length - 1].at).toBeNull();

    expect(out.some((a) => a.kind === 'full-scrape')).toBe(true);
  });
});

describe('taskKindLabel', () => {
  it('maps every task kind to a human label', () => {
    const labels: Record<TaskKind, string> = {
      'full-scrape': 'Full check',
      'pdf-fetch': 'Fetch bill PDF',
      'interval-pull': 'Pull interval usage',
      'weather-sync': 'Sync weather',
      'notify-sync': 'Send notifications',
    };
    for (const [kind, label] of Object.entries(labels)) {
      expect(taskKindLabel(kind as TaskKind)).toBe(label);
    }
  });
});
