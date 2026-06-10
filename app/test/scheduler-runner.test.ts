import { describe, expect, it } from 'vitest';
import {
  MIN_SCHEDULED_GAP_MS,
  groupByLogin,
  needsFreshInstall,
  orderPortalTasks,
  portalDeferUntil,
  splitDue,
} from '../src/lib/scheduler/runnerHelpers';
import type { ScheduledTaskRow, TaskKind } from '../src/lib/scheduler/types';

// These exercise the PURE runner helpers — fed plain arrays, no prisma/playwright
// (importing runnerHelpers must stay hermetic; if it weren't, this import fails).
const NOW = new Date('2026-06-10T12:00:00Z');

function row(kind: TaskKind, accountId: number | null, id = 1): ScheduledTaskRow {
  return { id, kind, accountId, payload: {}, nextRunAt: NOW, enabled: true };
}

// The portal/non-portal classification used in the real runner (full-scrape,
// pdf-fetch, interval-pull are portal; weather-sync, notify-sync are not).
const PORTAL: Record<TaskKind, boolean> = {
  'full-scrape': true,
  'pdf-fetch': true,
  'interval-pull': true,
  'weather-sync': false,
  'notify-sync': false,
};
const isPortal = (k: TaskKind) => PORTAL[k];

describe('splitDue', () => {
  it('partitions due tasks into portal vs non-portal by kind', () => {
    const tasks = [
      row('full-scrape', 1),
      row('weather-sync', 1),
      row('pdf-fetch', 1),
      row('notify-sync', 1),
      row('interval-pull', 1),
    ];
    const { portal, nonPortal } = splitDue(tasks, isPortal);
    expect(portal.map((t) => t.kind).sort()).toEqual(['full-scrape', 'interval-pull', 'pdf-fetch']);
    expect(nonPortal.map((t) => t.kind).sort()).toEqual(['notify-sync', 'weather-sync']);
  });

  it('handles an all-non-portal set (no portal session needed)', () => {
    const { portal, nonPortal } = splitDue([row('weather-sync', 1), row('notify-sync', 1)], isPortal);
    expect(portal).toHaveLength(0);
    expect(nonPortal).toHaveLength(2);
  });
});

describe('portalDeferUntil (throttle floor)', () => {
  it('returns null (run now) when there is no prior success', () => {
    expect(portalDeferUntil(null, NOW)).toBeNull();
  });

  it('defers when the last success is within the 5-min floor', () => {
    const lastSuccess = new Date(NOW.getTime() - 60 * 1000); // 1 min ago
    const deferUntil = portalDeferUntil(lastSuccess, NOW);
    expect(deferUntil).not.toBeNull();
    // Pushed to lastSuccess + gap.
    expect(deferUntil!.getTime()).toBe(lastSuccess.getTime() + MIN_SCHEDULED_GAP_MS);
  });

  it('runs (null) when the last success is older than the floor', () => {
    const lastSuccess = new Date(NOW.getTime() - (MIN_SCHEDULED_GAP_MS + 1000));
    expect(portalDeferUntil(lastSuccess, NOW)).toBeNull();
  });

  it('runs (null) exactly at the floor boundary', () => {
    const lastSuccess = new Date(NOW.getTime() - MIN_SCHEDULED_GAP_MS);
    expect(portalDeferUntil(lastSuccess, NOW)).toBeNull();
  });
});

describe('needsFreshInstall', () => {
  it('true when no full-scrape task exists', () => {
    expect(needsFreshInstall([])).toBe(true);
    expect(needsFreshInstall(['weather-sync', 'pdf-fetch'])).toBe(true);
  });
  it('false once any full-scrape task exists', () => {
    expect(needsFreshInstall(['full-scrape'])).toBe(false);
    expect(needsFreshInstall(['notify-sync', 'full-scrape', 'pdf-fetch'])).toBe(false);
  });
});

describe('groupByLogin', () => {
  it('groups multiple accounts under one login into a single session group', () => {
    const tasks = [row('full-scrape', 10, 1), row('pdf-fetch', 11, 2), row('full-scrape', 12, 3)];
    // accounts 10 & 11 → login 5; account 12 → login 6.
    const loginOf = (acct: number | null) => (acct === 12 ? 6 : 5);
    const groups = groupByLogin(tasks, loginOf);
    expect(groups.size).toBe(2);
    expect(groups.get('login:5')!.tasks).toHaveLength(2);
    expect(groups.get('login:6')!.tasks).toHaveLength(1);
  });

  it('keeps env-pass tasks (undefined login) in their own group, distinct from a numeric login', () => {
    const tasks = [row('full-scrape', null, 1), row('full-scrape', 9, 2)];
    const loginOf = (acct: number | null) => (acct == null ? undefined : 7);
    const groups = groupByLogin(tasks, loginOf);
    expect(groups.has('env')).toBe(true);
    expect(groups.has('login:7')).toBe(true);
    expect(groups.get('env')!.loginId).toBeUndefined();
  });
});

describe('orderPortalTasks', () => {
  it('orders full-scrape → interval-pull → pdf-fetch regardless of input order', () => {
    const tasks = [row('pdf-fetch', 1, 3), row('interval-pull', 1, 2), row('full-scrape', 1, 1)];
    expect(orderPortalTasks(tasks).map((t) => t.kind)).toEqual([
      'full-scrape',
      'interval-pull',
      'pdf-fetch',
    ]);
  });
});
