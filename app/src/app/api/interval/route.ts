import { NextResponse } from 'next/server';
import { getIntervalSeries } from '@/lib/queries';
import { withAccount } from '@/lib/route';
import { parseIntervalQuery } from '@/lib/intervalParams';
import { downsampleByTime, MAX_POINTS } from '@/lib/viz/downsampleInterval';
import { wasDownsampled } from '@/lib/intervalZoom';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Recent smart-meter interval reads (issue #76) for the HISTORY time-series line.
// READ-ONLY + additive: it returns the raw IntervalUsage rows for ONE fuel over a
// window, ordered by intervalStart, server-downsampled to ≤ MAX_POINTS for the
// line chart. This never touches /api/verify, the monthly series, or any
// billed-cost number.
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
// payload and the client render stay bounded for any range. This decimation is for
// the DISPLAY line ONLY. The day×hour heatmap, the average-day load shape and the
// peak-demand readout need the RAW finest grain (decimation merges adjacent hours
// → spurious "no data" cells, and decimates away 15-min demand spikes), so those
// aggregate SERVER-SIDE over the raw rows via the sibling /api/interval/heatmap +
// /api/interval/profile routes — NOT this downsampled feed (issue #77).
//
// No account / no data → { rows: [] } (the widget renders its friendly empty
// state, not a broken blank chart).
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const { fuelType, window } = parseIntervalQuery(params);

  return withAccount(
    req.url,
    () => NextResponse.json({ rows: [] }),
    async (acct) => {
      const rows = await getIntervalSeries(acct.id, { fuelType, ...window });
      // `downsampled` (issue #141) reports whether decimation actually reduced the
      // set — i.e. whether FINER detail exists than what's returned, so the history
      // widget can show its "Max zoom · finest detail" badge when it's false. It
      // mirrors downsampleByTime's own gate (raw rows > cap). ADDITIVE: `rows` is
      // returned exactly as before, so every other reader (the load-shape/heatmap
      // endpoints are separate) is unaffected.
      const downsampled = wasDownsampled(rows.length, MAX_POINTS);
      return NextResponse.json({ rows: downsampleByTime(rows, MAX_POINTS), downsampled });
    }
  );
}
