// One scheduler "tick": delegates to the generic task-runner, which runs any due
// ScheduledTask if anything is due (or bootstraps on a fresh install). Driven by a
// lightweight loop in docker-entrypoint.sh hitting /api/cron/tick — no in-process
// cron daemon (keeps the build edge-safe and the trigger reliable on the Node
// runtime).
import { runTick } from '@/lib/scheduler/runner';

export async function tickOnce(): Promise<{ ran: boolean; reason: string }> {
  return runTick('SCHEDULED');
}
