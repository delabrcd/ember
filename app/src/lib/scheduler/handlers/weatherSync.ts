// weather-sync handler (non-portal) — pull full-history daily temps from
// Open-Meteo for one account (NG's feed is ~24mo only). Reactive one-shot: armed
// by full-scrape (on both MANUAL and SCHEDULED, matching run.ts where weather
// runs on manual but notify does not), runs once, returns nextRunAt=null.
// Non-fatal — a weather hiccup must never fail the tick (run.ts:224-230).
import { syncHistoricalWeather } from '@/lib/weather/sync';
import { errMessage } from '@/lib/ngrid/errMessage';
import type { TaskContext, TaskHandler, TaskResult } from '@/lib/scheduler/types';

async function run(ctx: TaskContext): Promise<TaskResult> {
  const { task, log } = ctx;
  if (task.accountId == null) return { nextRunAt: null, status: 'SKIPPED', reason: 'no account' };
  try {
    const w = await syncHistoricalWeather(task.accountId);
    log(`weather: ${w.dailyUpserted} daily, ${w.monthsUpserted} monthly${w.skipped ? ` (${w.skipped})` : ''}`);
    return { nextRunAt: null, status: 'SUCCESS' };
  } catch (werr: unknown) {
    log(`weather sync skipped: ${errMessage(werr)}`);
    // Non-fatal: still self-deactivate (full-scrape re-arms next pass).
    return { nextRunAt: null, status: 'SUCCESS', reason: 'weather sync skipped' };
  }
}

export const weatherSyncHandler: TaskHandler = { kind: 'weather-sync', portal: false, run };
