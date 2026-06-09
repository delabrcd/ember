import { NextResponse } from 'next/server';
import { getIntervalSeries } from '@/lib/queries';
import { withAccount } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Recent smart-meter interval reads (issue #76) for the load-shape widget. READ-
// ONLY + additive: it returns the raw IntervalUsage rows for ONE fuel over a
// trailing window, ordered by intervalStart, and the widget shapes them client-
// side via the PURE averageDayProfile. This never touches /api/verify, the monthly
// series, or any billed-cost number.
//
//   ?fuel=ELECTRIC|GAS   (default ELECTRIC) — anything else falls back to ELECTRIC.
//   ?sinceDays=<n>       (default 30, clamped to 1..400) — the trailing window.
//   ?accountId=<id>      — scopes to that account (the shared resolveRequestAccount
//                          dance); omitted = the default account, bad id = 400.
//
// No account / no data → { rows: [] } (the widget renders its friendly empty
// state, not a broken blank chart).
const DEFAULT_SINCE_DAYS = 30;
const MIN_SINCE_DAYS = 1;
const MAX_SINCE_DAYS = 400;

function parseFuel(raw: string | null): 'ELECTRIC' | 'GAS' {
  return raw === 'GAS' ? 'GAS' : 'ELECTRIC';
}

function parseSinceDays(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_SINCE_DAYS;
  return Math.min(MAX_SINCE_DAYS, Math.max(MIN_SINCE_DAYS, Math.floor(n)));
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const fuelType = parseFuel(params.get('fuel'));
  const sinceDays = parseSinceDays(params.get('sinceDays'));
  return withAccount(
    req.url,
    () => NextResponse.json({ rows: [] }),
    async (acct) => NextResponse.json({ rows: await getIntervalSeries(acct.id, { fuelType, sinceDays }) })
  );
}
