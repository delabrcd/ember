import { NextResponse } from 'next/server';
import { getIntervalSeries } from '@/lib/queries';
import { withAccount } from '@/lib/route';
import { parseIntervalQuery } from '@/lib/intervalParams';
import { buildProfilePayload } from '@/lib/intervalAggregate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Display-ready AVERAGE-DAY LOAD-SHAPE profiles + peak-demand readout (issue #77).
// Takes the SAME fuel/from/to/sinceDays/accountId params the IntervalLoadShape
// widget already passed to /api/interval, but reads the RAW, un-downsampled
// IntervalUsage rows and aggregates them SERVER-SIDE into display-ready curves via
// the pure buildProfilePayload (standards §"API routes return display-ready data").
//
// WHY (the #77 bug): /api/interval downsamples to ≤600 points by absolute time for
// the history line; over a wide range each returned point can be ~32h averaged, so
// shaping a 24-hour profile from it destroys the hour-of-day structure. Aggregating
// over the RAW rows here keeps the profile correct on any range.
//
// ALL TOGGLE VARIANTS IN ONE PAYLOAD: the widget's split (combined/weekday/weekend)
// × granularity (1h/15m) toggles must stay INSTANT (no per-toggle refetch), so this
// returns every variant — bucketMinutes ∈ {60, 15} × split ∈ {combined, weekday,
// weekend} — computed once. The widget switches among them client-side; it only
// refetches when the fuel / range / account changes.
//
// UNSETTLED TAIL: the last SETTLE_HOURS (~48h) are excluded from the profiles + the
// peak (AMI reports the freshest hours as provisional 0s, biasing the curve down).
// This route is impure, so reading the current clock here is fine.
//
// No account / no data → an empty payload (the widget renders its empty state).
const SETTLE_HOURS = 48;

const EMPTY = {
  variants: {
    '60': { combined: [], weekday: [], weekend: [] },
    '15': { combined: [], weekday: [], weekend: [] },
  },
  peak: null,
};

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const { fuelType, window } = parseIntervalQuery(params);

  return withAccount(
    req.url,
    () => NextResponse.json(EMPTY),
    async (acct) => {
      const rows = await getIntervalSeries(acct.id, { fuelType, ...window });
      const before = new Date(Date.now() - SETTLE_HOURS * 3600_000);
      return NextResponse.json(buildProfilePayload(rows, { before }));
    }
  );
}
