import { NextResponse } from 'next/server';
import { getMonthlySeries, resolveRequestAccount } from '@/lib/queries';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ?accountId= scopes the series to that account; omitted = the default account.
export async function GET(req: Request) {
  const acct = await resolveRequestAccount(req.url);
  if (acct === 'invalid') return NextResponse.json({ error: 'unknown accountId' }, { status: 400 });
  if (!acct) return NextResponse.json({ rows: [] });
  return NextResponse.json({ rows: await getMonthlySeries(acct.id) });
}
