import { NextResponse } from 'next/server';
import {
  getIntervalAggregated,
  getIntervalRaw,
  getFifteenMinFrom,
  getFinestGrainInWindow,
} from '@/lib/queries';
import { withAccount } from '@/lib/route';
import { parseIntervalQuery, resolveWindowBounds } from '@/lib/intervalParams';
import { chooseBucket } from '@/lib/viz/chooseBucket';
import { toFifteenMinGrid } from '@/lib/viz/fifteenMinGrid';
import { MAX_POINTS } from '@/lib/viz/downsampleInterval';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Smart-meter interval reads (issue #76) for the "Usage history" line chart — ONE
// energy (kWh / therms) line per fuel over a window. READ-ONLY + additive: it never
// touches /api/verify, the monthly series, or any billed-cost number.
//
// FINEST-AVAILABLE, SERVER-PICKED RESOLUTION (WS1 rework of #36 / #143 / #77). The
// client no longer chooses a 1h/15m grain — the SERVER picks the bucket width from
// the requested [from, to] window so the returned series is always bounded
// (≤ MAX_POINTS points) AND every point is an honest SUM of the energy in its
// bucket (energy is additive: combine adjacent intervals, never subsample a
// representative point). The old route hydrated ~19.5k+8k rows into Node and
// reconciled/downsampled in JS on every request; now the aggregation happens in
// Postgres (getIntervalAggregated) and only the ≤ MAX_POINTS aggregated rows cross
// the wire.
//
//   ?fuel=ELECTRIC|GAS   (default ELECTRIC) — anything else falls back to ELECTRIC.
//   ?from=YYYY-MM-DD     — window start (inclusive). If from/to are present they
//   ?to=YYYY-MM-DD         WIN over sinceDays — this is the global-RangeControl path.
//   ?sinceDays=<n>       (default 30, 1..400) — trailing-window fallback for callers
//                          that don't pass from/to.
//   ?accountId=<id>      — scopes to that account (the shared resolveRequestAccount
//                          dance); omitted = the default account, bad id = 400.
//   ?grain=…             — IGNORED (back-compat: older widget builds sent it; the
//                          server now picks the bucket itself). Harmless if present.
//
// THE TWO PATHS (chosen by chooseBucket on the window span):
//   • bucketSecs ≥ 3600  → SQL RECONCILE-THEN-SUM. getIntervalAggregated collapses
//     the coexisting 15-min/hourly grains to one value per UTC hour
//     (reconcileToHourly's rule, in SQL — 4 complete 15-min slots win, else the
//     hourly row, else skip), then SUMs those into bucketSecs buckets. No row
//     hydration in Node.
//   • bucketSecs == 900  → the 15-MINUTE GRID. The window is small here (≤ ~6 days),
//     so we hydrate the raw 900s+3600s rows and shape a uniform 15-min grid in the
//     pure toFifteenMinGrid: real 900s where present, four equal quarter-steps for
//     hourly-only hours (so the line doesn't cliff-end at the start of 15-min data),
//     gaps elsewhere (never fabricated zeros).
//
// RESPONSE: { rows, grain, fifteenMinFrom, downsampled }
//   • rows           — the aggregated/gridded points (≤ MAX_POINTS), ascending.
//   • grain          — the chosen bucketSecs (900 / 3600 / …) so the client can label
//                      the resolution and format axes.
//   • fifteenMinFrom — the earliest 15-min (900s) intervalStart for this acct+fuel
//                      (ISO string, or null) so the widget can mark "end of 15-min
//                      data". Returned regardless of grain.
//   • downsampled    — true when bucketSecs is COARSER than the finest grain present
//                      in the window (finer detail exists than what's returned) →
//                      drives the widget's "finest detail" badge.
//
// No account / no data → { rows: [], grain, fifteenMinFrom: null, downsampled: false }
// (the widget renders its friendly empty state, not a broken blank chart).
//
// CACHE: interval data only changes on a scrape (every ~N minutes at most), so a
// short private cache window is safe and cheap. The response varies by
// ?accountId / ?fuel / ?from / ?to — all in the URL — so a URL-keyed cache stays
// correct per account; `private` keeps it in the user's browser regardless.
const CACHE_HEADER = 'private, max-age=120';

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const { fuelType, window } = parseIntervalQuery(params);
  // Resolve the parsed window to concrete bounds NOW (pure helper, clock injected)
  // so chooseBucket has a real span and the SQL has a real [from, to].
  const { from, to } = resolveWindowBounds(window, Date.now());
  const bucketSecs = chooseBucket(to.getTime() - from.getTime(), MAX_POINTS);

  return withAccount(
    req.url,
    () =>
      NextResponse.json(
        { rows: [], grain: bucketSecs, fifteenMinFrom: null, downsampled: false },
        { headers: { 'Cache-Control': CACHE_HEADER } }
      ),
    async (acct) => {
      // fifteenMinFrom + the finest in-window grain are independent of the chosen
      // path, so fetch them alongside the rows (two cheap index-backed lookups).
      const [rows, fifteenMinFrom, finestGrain] = await Promise.all([
        bucketSecs <= 900
          ? // 15-min grid: hydrate the small raw window and shape it purely.
            getIntervalRaw(acct.id, { fuelType, from, to }).then((raw) =>
              toFifteenMinGrid(raw, from.getTime(), to.getTime())
            )
          : // Coarser: reconcile-then-sum in SQL, ≤ MAX_POINTS rows back.
            getIntervalAggregated(acct.id, { fuelType, from, to, bucketSecs }),
        getFifteenMinFrom(acct.id, fuelType),
        getFinestGrainInWindow(acct.id, { fuelType, from, to }),
      ]);

      // `downsampled` = the returned bucket is coarser than the finest grain the
      // window actually holds → finer detail exists than what's shown. When the
      // window has no rows (finestGrain == null) nothing was reduced → false.
      const downsampled = finestGrain != null && bucketSecs > finestGrain;

      return NextResponse.json(
        {
          rows,
          grain: bucketSecs,
          fifteenMinFrom: fifteenMinFrom ? fifteenMinFrom.toISOString() : null,
          downsampled,
        },
        { headers: { 'Cache-Control': CACHE_HEADER } }
      );
    }
  );
}
