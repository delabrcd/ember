import { NextResponse } from 'next/server';
import { runScrape, ScrapeBusyError, ScrapeThrottledError } from '@/lib/ngrid/run';
import { errorResponse } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Scrapes can take a couple of minutes; the route returns immediately with a
// runId (the work continues in the background) so this mainly bounds startup.
export const maxDuration = 300;

export async function POST() {
  try {
    const runId = await runScrape('MANUAL');
    return NextResponse.json({ runId });
  } catch (e) {
    if (e instanceof ScrapeBusyError) return NextResponse.json({ error: 'busy' }, { status: 409 });
    if (e instanceof ScrapeThrottledError) return NextResponse.json({ error: 'throttled' }, { status: 429 });
    return errorResponse(e);
  }
}
