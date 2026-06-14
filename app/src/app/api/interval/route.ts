import { NextResponse } from 'next/server';
import { getIntervalSeries } from '@/lib/queries';
import { withAccount } from '@/lib/route';
import { parseIntervalQuery, FIFTEEN_MIN_SECONDS } from '@/lib/intervalParams';
import { reconcileToHourly } from '@/lib/intervalProfile';
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
//   ?grain=15m           — RAW 15-minute path: returns ONLY the 900s rows for the
//                          window, UN-decimated, ordered by intervalStart, with
//                          downsampled:false. 15-min data is inherently recent/
//                          bounded (NRT, ~days), so serving it raw is cheap. It
//                          exists because the 15m view used to consume the
//                          downsampled feed: over a wide range the recent 15-min
//                          sliver collapsed into a handful of representative rows,
//                          so the chart looked empty until the user zoomed in. Raw
//                          900s rows render at their true extent.
//   ?grain=1h            — HOURLY path: RECONCILE the raw mixed-grain rows to one
//                          value per hour (4 complete 15-min slots win, else the API
//                          hourly row) and THEN downsample to ≤ MAX_POINTS. The 1h
//                          history view uses this. The order is load-bearing — see
//                          the grain=='1h' branch below — and is why this can't just
//                          reuse the default 'all' feed.
//   (no grain)           — default 'all': returns ALL grains DOWNSAMPLED to
//                          ≤ MAX_POINTS (the smooth multi-year line). Kept for
//                          back-compat / non-dashboard callers; the dashboard's 1h
//                          view now uses grain=1h instead (a downsample-then-
//                          reconcile mix dropped the recent 15-min tail).
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
  const { fuelType, window, grain } = parseIntervalQuery(params);

  return withAccount(
    req.url,
    () => NextResponse.json({ rows: [] }),
    async (acct) => {
      // RAW 15-minute path (?grain=15m): push the 900s grain filter into the DB and
      // return those rows UN-decimated. 15-min data is inherently recent/bounded
      // (NRT, ~days), so this is cheap — and it avoids the time-bucket downsampler
      // collapsing the recent 15-min sliver to a handful of points over a wide
      // range. `downsampled` is correct-by-construction false here (we never
      // decimate), which keeps the widget's "Max zoom · finest detail" badge right.
      if (grain === '15m') {
        const rows = await getIntervalSeries(acct.id, {
          fuelType,
          ...window,
          intervalSeconds: FIFTEEN_MIN_SECONDS,
        });
        return NextResponse.json({ rows, downsampled: false });
      }
      // Hourly path (?grain=1h): RECONCILE the raw mixed-grain rows to one value
      // per hour FIRST (reconcileToHourly: four complete 15-min slots sum and win,
      // else the API hourly row), and only THEN downsample for display. This
      // ordering is the whole point of the param: the legacy 'all' path below
      // downsamples the mixed feed and leaves the client to reconcile, but
      // downsampling turns the recent 15-min rows into lone slots that reconcile's
      // "partial 15-min + no hourly → skip" rule discards — capping the 1h line at
      // the moment 15-min data begins (and we DO have a good hourly row for every
      // one of those hours). Reconciling over the RAW rows keeps the full timeline.
      // `downsampled` reflects whether the RECONCILED (hourly) set exceeded the cap,
      // so the widget's "finest detail" badge stays correct.
      if (grain === '1h') {
        const raw = await getIntervalSeries(acct.id, { fuelType, ...window });
        const hourly = reconcileToHourly(raw);
        const downsampled = wasDownsampled(hourly.length, MAX_POINTS);
        return NextResponse.json({ rows: downsampleByTime(hourly, MAX_POINTS), downsampled });
      }
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
