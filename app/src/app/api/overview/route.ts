import { NextResponse } from 'next/server';
import { getOverview, resolveRequestAccount } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ?accountId= scopes the overview to that account; omitted = the default account.
export async function GET(req: Request) {
  const acct = await resolveRequestAccount(req.url);
  if (acct === 'invalid') return NextResponse.json({ error: 'unknown accountId' }, { status: 400 });
  if (!acct) return NextResponse.json({ empty: true });
  return NextResponse.json(await getOverview(acct.id));
}
