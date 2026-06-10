import { NextResponse } from 'next/server';
import { runScrape, ScrapeBusyError, ScrapeThrottledError } from '@/lib/ngrid/run';
import { runManual } from '@/lib/scheduler/runner';
import { errorResponse } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Scrapes can take a couple of minutes; the route returns immediately with a
// runId (the work continues in the background) so this mainly bounds startup.
export const maxDuration = 300;

export async function POST() {
  try {
    // Scheduler V2 (flag-gated, default OFF): the manual refresh runs the generic
    // runner's full portal pass. runManual() shares the V2 inFlight lock and
    // throws the same ScrapeBusyError on a busy lock, so the catch below is
    // unchanged. When the flag is off, the legacy runScrape path runs untouched.
    const runId =
      process.env.SCHEDULER_V2 === 'true' ? await runManual() : await runScrape('MANUAL');
    return NextResponse.json({ runId });
  } catch (e) {
    if (e instanceof ScrapeBusyError) return NextResponse.json({ error: 'busy' }, { status: 409 });
    if (e instanceof ScrapeThrottledError) return NextResponse.json({ error: 'throttled' }, { status: 429 });
    return errorResponse(e);
  }
}
