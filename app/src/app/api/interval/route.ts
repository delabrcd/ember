import { NextResponse } from 'next/server';
import { getIntervalSeries } from '@/lib/queries';
import { withAccount } from '@/lib/route';
import { downsampleByTime, MAX_POINTS } from '@/lib/viz/downsampleInterval';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Recent smart-meter interval reads (issue #76) for the load-shape + history
// widgets. READ-ONLY + additive: it returns the raw IntervalUsage rows for ONE
// fuel over a window, ordered by intervalStart, and the widgets shape them client-
// side (averageDayProfile / toHistoryPoints). This never touches /api/verify, the
// monthly series, or any billed-cost number.
//
//   ?fuel=ELECTRIC|GAS   (default ELECTRIC) — anything else falls back to ELECTRIC.
//   ?from=YYYY-MM-DD     — window start (inclusive). If from/to are present they
//   ?to=YYYY-MM-DD         WIN over sinceDays — this is the global-RangeControl path.
//   ?sinceDays=<n>       (default 30, clamped to 1..400) — trailing-window fallback
//                          for callers that don't pass from/to.
//   ?accountId=<id>      — scopes to that account (the shared resolveRequestAccount
//                          dance); omitted = the default account, bad id = 400.
//
// DOWNSAMPLING (issue #36): a wide range (e.g. "All" = 2+ years of hourly ≈ 17k
// rows) is decimated SERVER-SIDE to ≤ MAX_POINTS (~600) representative rows via
// the PURE downsampleByTime (bucket-mean) before it leaves the route, so both the
// payload and the client render stay bounded for any range. Raw rows are downsampled
// directly (the client reconciles 15m→1h after); over a wide window the grain is
// uniform hourly anyway (15-min electric only exists for ~48h), so server-side
// decimation loses no meaningful detail and is for DISPLAY only.
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

// Parse a YYYY-MM-DD param to a UTC Date, or null if absent/unparseable. `to` is
// widened to the END of its day (23:59:59.999 UTC) so an inclusive [from,to] day
// span captures every read on the last day. PURE.
function parseDate(raw: string | null, endOfDay: boolean): Date | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = endOfDay
    ? Date.UTC(y, mo - 1, d, 23, 59, 59, 999)
    : Date.UTC(y, mo - 1, d, 0, 0, 0, 0);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const fuelType = parseFuel(params.get('fuel'));
  let from = parseDate(params.get('from'), false);
  let to = parseDate(params.get('to'), true);
  // If both bounds parsed but are inverted, swap so the query window is sane.
  if (from && to && from.getTime() > to.getTime()) {
    [from, to] = [to, from];
  }
  const hasWindow = !!(from || to);
  const sinceDays = hasWindow ? undefined : parseSinceDays(params.get('sinceDays'));

  return withAccount(
    req.url,
    () => NextResponse.json({ rows: [] }),
    async (acct) => {
      const rows = await getIntervalSeries(acct.id, {
        fuelType,
        ...(hasWindow ? { from: from ?? undefined, to: to ?? undefined } : { sinceDays }),
      });
      return NextResponse.json({ rows: downsampleByTime(rows, MAX_POINTS) });
    }
  );
}
