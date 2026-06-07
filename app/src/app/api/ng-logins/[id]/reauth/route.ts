import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { deriveKey } from '@/lib/crypto';
import { startReauthPreflight } from '@/lib/ngrid/preflight';
import { errorResponse, parseIdParam } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// POST — start an interactive re-authentication pre-flight for an EXISTING login.
// Decrypts the stored credential and runs the same headless login + OTP flow as
// Add; on success the saved session is refreshed and the row returns to
// status='verified'. Returns a pre-flight id to poll (and the existing
// /preflight/:id + /preflight/:id/otp routes drive it), exactly like Add — no
// password is sent by the client.
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  const id = parseIdParam(params.id);
  if (id instanceof Response) return id;

  // Without the key we can't decrypt the stored credential, so there's no point
  // launching a login.
  try {
    deriveKey();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || 'NGRID_SECRET_KEY is not configured.' },
      { status: 400 }
    );
  }

  const login = await prisma.ngLogin.findUnique({ where: { id }, select: { id: true } });
  if (!login) return NextResponse.json({ error: 'not found' }, { status: 404 });

  try {
    const { id: preflightId } = startReauthPreflight(id);
    return NextResponse.json({ preflightId, status: 'RUNNING' });
  } catch (e) {
    return errorResponse(e);
  }
}
