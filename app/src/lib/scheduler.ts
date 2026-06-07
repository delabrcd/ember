// One scheduler "tick": run a SCHEDULED scrape if any account is due (or if we
// have never scraped yet). Driven by a lightweight loop in docker-entrypoint.sh
// hitting /api/cron/tick — no in-process cron daemon (keeps the build edge-safe
// and the trigger reliable on the Node runtime).
import { prisma } from '@/lib/db';
import { bootstrapEnvLogin } from '@/lib/ngrid/bootstrap';
import { ScrapeBusyError, ScrapeThrottledError, runScrape } from '@/lib/ngrid/run';
import { isSchedulerEnabled } from '@/lib/settings';

// Process-level guard so the env→NgLogin cutover bootstrap only does its DB query
// once per process (it's a no-op after the first import, so re-checking every
// hourly tick would be wasted work). The FIRST tick after boot is the bootstrap's
// sole trigger in the production image (Next's instrumentation `register()` hook
// does NOT fire under `npx next start`, so this path must own the cutover).
let bootstrapRan = false;

export async function tickOnce(): Promise<{ ran: boolean; reason: string }> {
  // Run the one-time env→NgLogin cutover bootstrap before any due/disabled checks
  // so a fresh prod deploy is migrated to the encrypted store even when the
  // scheduler is disabled. `bootstrapEnvLogin()` is idempotent (username-exists
  // check) and never throws, so it can't break the tick.
  if (!bootstrapRan) {
    bootstrapRan = true;
    await bootstrapEnvLogin();
  }

  if (!(await isSchedulerEnabled())) return { ran: false, reason: 'disabled' };
  const states = await prisma.scheduleState.findMany();
  const now = new Date();
  const due = states.some((s) => s.nextCheckAt != null && s.nextCheckAt <= now);
  if (states.length === 0 || due) {
    try {
      await runScrape('SCHEDULED', (m) => console.log('[scheduler]', m));
      return { ran: true, reason: states.length === 0 ? 'initial' : 'due' };
    } catch (e) {
      if (e instanceof ScrapeBusyError) return { ran: false, reason: 'busy' };
      if (e instanceof ScrapeThrottledError) return { ran: false, reason: 'throttled' };
      throw e;
    }
  }
  return { ran: false, reason: 'not-due' };
}
