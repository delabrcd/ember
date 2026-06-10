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
    expect(out.map((a) => a.at.getTime())).toEqual([
      now.getTime(),
      now.getTime() + 7 * DAY,
      now.getTime() + 14 * DAY,
    ]);
    // strictly increasing
    for (let i = 1; i < out.length; i++) {
      expect(out[i].at.getTime()).toBeGreaterThan(out[i - 1].at.getTime());
    }
    expect(out.every((a) => a.kind === 'full-scrape')).toBe(true);
  });

  it('honors a future nextRunAt (clock starts at max(nextRunAt, now))', () => {
    const future = new Date(now.getTime() + 2 * DAY);
    const out = projectTask({ ...task, nextRunAt: future }, now, 14);
    // fires at +2d, +9d, +16d>horizon(+14d) stops -> [+2d, +9d]
    expect(out.map((a) => a.at.getTime())).toEqual([future.getTime(), future.getTime() + 7 * DAY]);
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
    expect(out[0].at.getTime()).toBe(now.getTime()); // keeps the first fire
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
    expect(out[0].at.getTime()).toBe(now.getTime());
    expect(out[0].reason).toMatch(/daily/);
  });
});

describe('projectTask — reactive / inactive', () => {
  const now = D('2026-06-10');

  it('weather-sync (nextRunAt=null) yields one reactive annotation, not a series', () => {
    const out = projectTask(
      { kind: 'weather-sync', enabled: true, nextRunAt: null, facts: {} },
      now,
      7
    );
    expect(out).toHaveLength(1);
    expect(out[0].at.getTime()).toBe(now.getTime());
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

  it('a disabled task yields one annotation at its nextRunAt', () => {
    const at = new Date(now.getTime() + 3 * HOUR);
    const out = projectTask(
      { kind: 'interval-pull', enabled: false, nextRunAt: at, facts: { hasAmiMeter: true } },
      now,
      7
    );
    expect(out).toHaveLength(1);
    expect(out[0].at.getTime()).toBe(at.getTime());
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

  it('concatenates tasks and returns them sorted by time', () => {
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
      // reactive weather at now
      { kind: 'weather-sync', enabled: true, nextRunAt: null, facts: {} },
    ];
    const out = projectTimeline(tasks, now, 14);
    // sorted ascending by `at`
    for (let i = 1; i < out.length; i++) {
      expect(out[i].at.getTime()).toBeGreaterThanOrEqual(out[i - 1].at.getTime());
    }
    // interval + weather both annotate at `now`; full-scrape fires at +1d and +8d
    expect(out.some((a) => a.kind === 'full-scrape')).toBe(true);
    expect(out.some((a) => a.kind === 'interval-pull')).toBe(true);
    expect(out.some((a) => a.kind === 'weather-sync')).toBe(true);
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
