import { NextResponse } from 'next/server';
import {
  getIntervalAggregated,
  getIntervalRaw,
  getFifteenMinFrom,
  getFinestGrainInWindow,
} from '@/lib/queries';
import { withAccount } from '@/lib/route';
import { parseIntervalQuery, resolveWindowBounds, resolveServedBucket } from '@/lib/intervalParams';
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
//   ?grain=…             — IGNORED and no longer parsed (back-compat: older widget
//                          builds sent it; the server now picks the bucket itself).
//                          Harmless if present.
//   ?bucket=<secs>       — WS8 OVERSCAN (optional): an EXPLICIT bucket width (one of
//                          the chooseBucket ladder widths) to aggregate this [from,to]
//                          at, SKIPPING the span→bucket choice. The overscan client
//                          loads a window WIDER than the visible view but wants it
//                          aggregated at the VIEW's grain (else the wider span would
//                          make chooseBucket pick a coarser bucket and the visible
//                          slice would render too coarse). Validated against the
//                          ladder (parseBucket); off-ladder/garbage → ignored (server
//                          picks, unchanged pre-WS8 behaviour). When bucket===900 the
//                          15-min-grid path fires exactly as a server-chosen 900 would
//                          — subject to WS9 Fix 3 (a 900 over an entirely hourly-only
//                          window is served as 3600 instead of fabricated flats).
//
// THE TWO PATHS (chosen by chooseBucket on the window span, OR by an explicit
// ?bucket=, then refined by what the window actually CONTAINS — WS9 Fix 3):
//   • servedBucket ≥ 3600 → SQL RECONCILE-THEN-SUM. getIntervalAggregated collapses
//     the coexisting 15-min/hourly grains to one value per UTC hour
//     (reconcileToHourly's rule, in SQL — 4 complete 15-min slots win, else the
//     hourly row, else skip), then SUMs those into servedBucket buckets. No row
//     hydration in Node. WS9 Fix 2: each bucket's point is anchored at the LATEST
//     reading in it (not the bucket start) so the trailing edge reaches recent data.
//   • servedBucket == 900 → the 15-MINUTE GRID. The window is small here (≤ ~6 days),
//     so we hydrate the raw 900s+3600s rows and shape a uniform 15-min grid in the
//     pure toFifteenMinGrid: real 900s where present, four equal quarter-steps for
//     hourly-only hours (so the line doesn't cliff-end at the start of 15-min data),
//     gaps elsewhere (never fabricated zeros).
//
// WS9 Fix 3 — STRADDLE-ONLY extrapolation. A requested 900 is only SERVED as the
// 15-min grid when the window genuinely has 15-min rows. resolveServedBucket probes
// the finest in-window grain: if it's 900 (straddle or all-15-min) → grid (flats fill
// only the hourly-only side); if the window is entirely hourly-only (no 900s rows) →
// FALL BACK to hourly (3600) — the finest REAL grain there — instead of fabricating an
// all-fake 15-min view of old hourly data. `grain` in the response reflects the SERVED
// bucket (3600 in the fallback).
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
// ?accountId / ?fuel / ?from / ?to / ?bucket — all in the URL — so a URL-keyed cache
// stays correct per account; `private` keeps it in the user's browser regardless.
const CACHE_HEADER = 'private, max-age=120';

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const { fuelType, window, bucket } = parseIntervalQuery(params);
  // Resolve the parsed window to concrete bounds NOW (pure helper, clock injected)
  // so chooseBucket has a real span and the SQL has a real [from, to].
  const { from, to } = resolveWindowBounds(window, Date.now());
  // WS8 OVERSCAN: an explicit, ladder-validated ?bucket= WINS over the span→bucket
  // choice, so an overscan superset (a window WIDER than the visible view) is
  // aggregated at the VIEW's grain rather than the wider span's coarser grain. Absent
  // / invalid bucket → chooseBucket from the span (unchanged behaviour). Either way
  // `bucketSecs` drives both the path selection and the returned `grain`.
  const bucketSecs = bucket ?? chooseBucket(to.getTime() - from.getTime(), MAX_POINTS);

  return withAccount(
    req.url,
    () =>
      NextResponse.json(
        { rows: [], grain: bucketSecs, fifteenMinFrom: null, downsampled: false },
        { headers: { 'Cache-Control': CACHE_HEADER } }
      ),
    async (acct) => {
      // fifteenMinFrom + the finest in-window grain are independent of the chosen
      // path; the finest grain ALSO decides the served bucket (WS9 Fix 3), so probe
      // both BEFORE fetching the rows (two cheap index-backed lookups).
      const [fifteenMinFrom, finestGrain] = await Promise.all([
        getFifteenMinFrom(acct.id, fuelType),
        getFinestGrainInWindow(acct.id, { fuelType, from, to }),
      ]);

      // WS9 (Fix 3): only extrapolate hourly→15-min in the STRADDLE. When 900 is
      // requested but the window has NO real 15-min rows (entirely hourly-only — a
      // deep-history view zoomed narrow), the 15-min grid would fabricate an all-fake
      // flats view; instead serve the hourly (3600) aggregation — the finest REAL
      // grain there. `servedBucket` reflects what's actually served and drives BOTH
      // the path selection and the response `grain`. (When real 15-min IS present —
      // straddle or all-15-min — servedBucket stays 900 and the grid fills only the
      // hourly-only side with flats, unchanged.)
      const servedBucket = resolveServedBucket(bucketSecs, finestGrain);

      const rows =
        servedBucket <= 900
          ? // 15-min grid: hydrate the small raw window and shape it purely.
            await getIntervalRaw(acct.id, { fuelType, from, to }).then((raw) =>
              toFifteenMinGrid(raw, from.getTime(), to.getTime())
            )
          : // Coarser: reconcile-then-sum in SQL, ≤ MAX_POINTS rows back.
            await getIntervalAggregated(acct.id, { fuelType, from, to, bucketSecs: servedBucket });

      // `downsampled` = the SERVED bucket is coarser than the finest grain the window
      // actually holds → finer detail exists than what's shown. When the window has no
      // rows (finestGrain == null) nothing was reduced → false. (In the Fix-3 fallback
      // servedBucket==3600==finestGrain, so this is correctly false — hourly IS the
      // finest there.)
      const downsampled = finestGrain != null && servedBucket > finestGrain;

      return NextResponse.json(
        {
          rows,
          grain: servedBucket,
          fifteenMinFrom: fifteenMinFrom ? fifteenMinFrom.toISOString() : null,
          downsampled,
        },
        { headers: { 'Cache-Control': CACHE_HEADER } }
      );
    }
  );
}
