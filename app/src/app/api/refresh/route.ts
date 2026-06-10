import { NextResponse } from 'next/server';
import { runManual } from '@/lib/scheduler/runner';
import { ScrapeBusyError, ScrapeThrottledError } from '@/lib/scheduler/progress';
import { errorResponse } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Scrapes can take a couple of minutes; the route returns immediately with a
// runId (the work continues in the background) so this mainly bounds startup.
export const maxDuration = 300;

export async function POST() {
  try {
    // The manual refresh runs the generic runner's full portal pass. runManual()
    // shares the runner's inFlight lock and throws ScrapeBusyError on a busy lock,
    // so the catch below covers the busy/throttled cases.
    const runId = await runManual();
    return NextResponse.json({ runId });
  } catch (e) {
    if (e instanceof ScrapeBusyError) return NextResponse.json({ error: 'busy' }, { status: 409 });
    if (e instanceof ScrapeThrottledError) return NextResponse.json({ error: 'throttled' }, { status: 429 });
    return errorResponse(e);
  }
}
