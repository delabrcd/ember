import { NextResponse } from 'next/server';
import { getMonthlySeries } from '@/lib/queries';
import { withAccount } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ?accountId= scopes the series to that account; omitted = the default account.
export async function GET(req: Request) {
  return withAccount(
    req.url,
    () => NextResponse.json({ rows: [] }),
    async (acct) => NextResponse.json({ rows: await getMonthlySeries(acct.id) })
  );
}
