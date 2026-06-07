import { NextResponse } from 'next/server';
import { tickOnce } from '@/lib/scheduler';
import { errorResponse } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 300;

// Called by the in-container background loop (docker-entrypoint.sh). Guarded by a
// shared key so it can't be triggered from outside if the port is ever exposed.
export async function POST(req: Request) {
  const key = process.env.CRON_KEY;
  if (key && req.headers.get('x-cron-key') !== key) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  try {
    const result = await tickOnce();
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
