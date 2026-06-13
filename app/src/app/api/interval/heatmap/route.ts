import { NextResponse } from 'next/server';
import { getIntervalSeries } from '@/lib/queries';
import { withAccount } from '@/lib/route';
import { parseIntervalQuery } from '@/lib/intervalParams';
import { buildHeatmapPayload } from '@/lib/intervalAggregate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Display-ready DAY×HOUR HEATMAP + peak-demand readout (issue #77). Takes the SAME
// fuel/from/to/sinceDays/accountId params the IntervalHeatmap widget already
// passed to /api/interval, but reads the RAW, un-downsampled IntervalUsage rows
// and aggregates them SERVER-SIDE into a small display-ready grid via the pure
// buildHeatmapPayload (standards §"API routes return display-ready data").
//
// WHY (the #77 bug): /api/interval downsamples to ≤600 points by absolute time for
// the history line; running day-of-week × hour-of-day binning over that
// time-decimated series merges adjacent hours and produces SPURIOUS "no data"
// cells even when the DB has every cell populated. Aggregating over the RAW rows
// here fixes that — every (dow, hour) cell that truly has data is populated, a
// genuinely-absent cell stays null (never a fabricated zero), and the peak
// reflects the finest 15-min grain.
//
// UNSETTLED TAIL: the last SETTLE_HOURS (~48h) are excluded — AMI meters report
// the freshest hours as provisional 0s then fill in, which would drag a cell's
// average down and let a partial fresh interval read as a false peak. This route
// is impure, so reading the current clock here is fine.
//
// No account / no data → an empty grid payload (the widget renders its friendly
// empty state).
const SETTLE_HOURS = 48;

const EMPTY = {
  grid: { xs: [], ys: [], cells: [], min: 0, max: 0 },
  rowLabels: {},
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
      return NextResponse.json(buildHeatmapPayload(rows, { before }));
    }
  );
}
