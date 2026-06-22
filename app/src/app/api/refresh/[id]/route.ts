import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { parseIdParam, errorResponse } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const id = parseIdParam(params.id);
  if (id instanceof Response) return id;
  // try/catch → the uniform { error } + 500 envelope (issue #159); the explicit
  // 404 below stays its own status.
  try {
    const run = await prisma.scrapeRun.findUnique({ where: { id } });
    if (!run) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({
      id: run.id,
      status: run.status,
      trigger: run.trigger,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      billsAdded: run.billsAdded,
      message: run.message,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
