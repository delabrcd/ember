import { NextResponse } from 'next/server';
import { getOverview } from '@/lib/queries';
import { withAccount } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ?accountId= scopes the overview to that account; omitted = the default account.
export async function GET(req: Request) {
  return withAccount(
    req.url,
    () => NextResponse.json({ empty: true }),
    async (acct) => NextResponse.json(await getOverview(acct.id))
  );
}
