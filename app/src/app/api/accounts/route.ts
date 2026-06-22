import { NextResponse } from 'next/server';
import { listAccounts } from '@/lib/queries';
import { errorResponse } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/accounts — every billing account, grouped/labelled client-side by the
// switcher. Each row carries its login id + label (null for env-bootstrapped
// accounts); the shaping is the pure shapeAccount and never leaks a credential.
export async function GET() {
  // try/catch → the uniform { error } + 500 envelope (issue #159).
  try {
    return NextResponse.json({ accounts: await listAccounts() });
  } catch (e) {
    return errorResponse(e);
  }
}
