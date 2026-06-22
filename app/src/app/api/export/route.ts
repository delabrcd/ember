import { NextResponse } from 'next/server';
import { getBills, getMonthlySeries } from '@/lib/queries';
import { withAccount } from '@/lib/route';
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

  // Wrap the CSV string in the download Response (shared by the no-account and
  // resolved-account paths). seriesToCsv / billsToCsv with no rows already emit
  // the header line, so the no-account branch is the same header-only CSV the old
  // `acct ? … : []` path returned.
  const date = new Date().toISOString().slice(0, 10);
  const csvResponse = (csv: string) =>
    new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="ngrid-${dataset}-${date}.csv"`,
      },
    });
  const emptyCsv = () =>
    csvResponse(
      dataset === 'series'
        ? seriesToCsv(filterByYm([], range))
        : billsToCsv(filterBillsByYm([], range))
    );

  // The shared resolveRequestAccount dance: bad ?accountId= → 400, no account →
  // header-only CSV, otherwise build the scoped export.
  return withAccount(req.url, emptyCsv, async (acct) => {
    if (dataset === 'series') {
      return csvResponse(seriesToCsv(filterByYm(await getMonthlySeries(acct.id), range)));
    }
    return csvResponse(billsToCsv(filterBillsByYm(await getBills(acct.id), range)));
  });
}
