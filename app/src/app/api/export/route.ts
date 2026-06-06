import { NextResponse } from 'next/server';
import { getBills, getMonthlySeries, resolveRequestAccount } from '@/lib/queries';
import { billsToCsv, seriesToCsv } from '@/lib/csv';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/export?dataset=series|bills[&accountId=] — downloads the monthly
// series or the bills list as a CSV file, scoped to ?accountId= (omitted = the
// default account) so an export matches what's on screen. Cost columns reuse the
// pipeline's correct sourcing (the bill PDF's current charges, not the API
// amount due); the shaping is pure in lib/csv.ts. With no account/data we still
// return a header-only CSV.
export async function GET(req: Request) {
  const dataset = new URL(req.url).searchParams.get('dataset');
  if (dataset !== 'series' && dataset !== 'bills') {
    return NextResponse.json({ error: "dataset must be 'series' or 'bills'" }, { status: 400 });
  }

  const resolved = await resolveRequestAccount(req.url);
  if (resolved === 'invalid') return NextResponse.json({ error: 'unknown accountId' }, { status: 400 });
  const acct = resolved;
  let csv: string;
  if (dataset === 'series') {
    csv = seriesToCsv(acct ? await getMonthlySeries(acct.id) : []);
  } else {
    csv = billsToCsv(acct ? await getBills(acct.id) : []);
  }

  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ngrid-${dataset}-${date}.csv"`,
    },
  });
}
