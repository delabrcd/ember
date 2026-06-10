import { describe, expect, it } from 'vitest';
import { planAccountTasks } from '../src/lib/scheduler/seed';
import type { TaskKind } from '../src/lib/scheduler/types';

const NOW = new Date('2026-06-10T12:00:00Z');
const FUTURE = new Date('2026-06-17T08:00:00Z'); // a live ScheduleState.nextCheckAt

// The seed planner is PURE — these are hand-built facts. (Importing it must NOT
// pull the prisma singleton at runtime; seed.ts uses a type-only PrismaClient
// import, so this suite stays hermetic — if it weren't, this import would fail.)
function find(specs: ReturnType<typeof planAccountTasks>, kind: TaskKind) {
  const s = specs.find((x) => x.kind === kind);
  if (!s) throw new Error(`missing ${kind}`);
  return s;
}

describe('planAccountTasks (hand-calculated)', () => {
  it('fresh account, no ScheduleState, no pending PDF: full-scrape & interval run now, rest off', () => {
    const specs = planAccountTasks({ scheduleNextCheckAt: null, hasRecentPendingPdf: false }, NOW);
    expect(find(specs, 'full-scrape').nextRunAt).toBe(NOW);
    expect(find(specs, 'interval-pull').nextRunAt).toBe(NOW);
    expect(find(specs, 'pdf-fetch').nextRunAt).toBeNull();
    expect(find(specs, 'weather-sync').nextRunAt).toBeNull();
    expect(find(specs, 'notify-sync').nextRunAt).toBeNull();
  });

  it('preserves a live cadence: full-scrape uses the existing nextCheckAt exactly', () => {
    const specs = planAccountTasks({ scheduleNextCheckAt: FUTURE, hasRecentPendingPdf: false }, NOW);
    expect(find(specs, 'full-scrape').nextRunAt).toBe(FUTURE);
    // The others are unaffected by the existing schedule.
    expect(find(specs, 'interval-pull').nextRunAt).toBe(NOW);
    expect(find(specs, 'pdf-fetch').nextRunAt).toBeNull();
    expect(find(specs, 'weather-sync').nextRunAt).toBeNull();
    expect(find(specs, 'notify-sync').nextRunAt).toBeNull();
  });

  it('arms pdf-fetch to run now when a recent bill is still missing its PDF', () => {
    const specs = planAccountTasks({ scheduleNextCheckAt: null, hasRecentPendingPdf: true }, NOW);
    expect(find(specs, 'pdf-fetch').nextRunAt).toBe(NOW);
    // full-scrape/interval still run now; reactive tasks still off.
    expect(find(specs, 'full-scrape').nextRunAt).toBe(NOW);
    expect(find(specs, 'interval-pull').nextRunAt).toBe(NOW);
    expect(find(specs, 'weather-sync').nextRunAt).toBeNull();
    expect(find(specs, 'notify-sync').nextRunAt).toBeNull();
  });

  it('returns exactly the 5 kinds in the documented stable order', () => {
    const specs = planAccountTasks({ scheduleNextCheckAt: FUTURE, hasRecentPendingPdf: true }, NOW);
    expect(specs).toHaveLength(5);
    expect(specs.map((s) => s.kind)).toEqual([
      'full-scrape',
      'interval-pull',
      'pdf-fetch',
      'weather-sync',
      'notify-sync',
    ]);
  });
});
