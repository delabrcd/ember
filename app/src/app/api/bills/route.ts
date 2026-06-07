import { NextResponse } from 'next/server';
import { getBills } from '@/lib/queries';
import { withAccount } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// ?accountId= scopes the bills list to that account; omitted = the default account.
export async function GET(req: Request) {
  return withAccount(
    req.url,
    () => NextResponse.json({ bills: [] }),
    async (acct) => NextResponse.json({ bills: await getBills(acct.id) })
  );
}
