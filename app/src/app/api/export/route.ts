import { NextResponse } from 'next/server';
import { getBills, getMonthlySeries, resolveRequestAccount } from '@/lib/queries';
import { unknownAccount } from '@/lib/route';
import { billsToCsv, seriesToCsv } from '@/lib/csv';
import { filterByYm, filterBillsByYm } from '@/lib/range';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Parse an optional from/to ym (YYYYMM) bound; null when absent or unparseable
// (so a missing/garbage param just means "no bound on that side").
function ymParam(v: string | null): number | null {
  if (!v) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 100001 && n <= 999912 ? n : null;
}

// GET /api/export?dataset=series|bills[&accountId=][&from=YYYYMM&to=YYYYMM] —
// downloads the monthly series or the bills list as a CSV file, scoped to
// ?accountId= (omitted = the default account) AND an optional ym date range so an
// export matches what's on screen. Cost columns reuse the pipeline's correct
// sourcing (the bill PDF's current charges, not the API amount due); the shaping
// and range filtering are pure (lib/csv.ts, lib/range.ts). With no account/data
// we still return a header-only CSV.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const dataset = url.searchParams.get('dataset');
  if (dataset !== 'series' && dataset !== 'bills') {
    return NextResponse.json({ error: "dataset must be 'series' or 'bills'" }, { status: 400 });
  }

  // Optional ym range. Absent → open-ended on that side (full history).
  const fromYm = ymParam(url.searchParams.get('from')) ?? 100001;
  const toYm = ymParam(url.searchParams.get('to')) ?? 999912;
  const range = { fromYm, toYm };

  const resolved = await resolveRequestAccount(req.url);
  if (resolved === 'invalid') return unknownAccount();
  const acct = resolved;
  let csv: string;
  if (dataset === 'series') {
    const rows = acct ? await getMonthlySeries(acct.id) : [];
    csv = seriesToCsv(filterByYm(rows, range));
  } else {
    const bills = acct ? await getBills(acct.id) : [];
    csv = billsToCsv(filterBillsByYm(bills, range));
  }

  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="ngrid-${dataset}-${date}.csv"`,
    },
  });
}
