import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { errorResponse } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  // try/catch → the uniform { error } + 500 envelope (issue #159); without it a
  // Prisma blip surfaced as Next's default unstructured 500.
  try {
    const runs = await prisma.scrapeRun.findMany({ orderBy: { startedAt: 'desc' }, take: 12 });
    return NextResponse.json({
      runs: runs.map((r) => ({
        id: r.id,
        trigger: r.trigger,
        status: r.status,
        startedAt: r.startedAt.toISOString(),
        finishedAt: r.finishedAt?.toISOString() ?? null,
        billsAdded: r.billsAdded,
        message: r.message,
      })),
    });
  } catch (e) {
    return errorResponse(e);
  }
}
