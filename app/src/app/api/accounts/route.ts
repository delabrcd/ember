import { NextResponse } from 'next/server';
import { listAccounts } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/accounts — every billing account, grouped/labelled client-side by the
// switcher. Each row carries its login id + label (null for env-bootstrapped
// accounts); the shaping is the pure shapeAccount and never leaks a credential.
export async function GET() {
  return NextResponse.json({ accounts: await listAccounts() });
}
