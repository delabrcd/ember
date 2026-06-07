// IMPURE wrapper for the seasonal projection's expected degree-days (issue #52):
// read cached daily history for the climatological normals and delegate the
// arithmetic to the PURE assembleExpectedDegreeDays(). Kept in its own module
// (separate from the pure math) so the math stays unit-testable without a
// DB/Prisma client.

import { prisma } from '@/lib/db';
import {
  assembleExpectedDegreeDays,
  dayOfYearNormals,
  daysInRange,
  overallMean,
} from './expectedDegreeDays';
import type { ExpectedDegreeDays } from '@/lib/prediction';
import { isoDate as ymd, ymAddMonths } from '@/lib/ym';

// First/last UTC day of a YYYYMM calendar month.
const ymMonthStart = (ym: number) => new Date(Date.UTC(Math.floor(ym / 100), (ym % 100) - 1, 1));
const ymMonthEnd = (ym: number) => new Date(Date.UTC(Math.floor(ym / 100), ym % 100, 0));

// IMPURE per-future-month NORMAL degree-days for the 12-month seasonal projection
// (issue #52). For each of the 12 calendar months after `latestYm` we sum the
// climatological-NORMAL HDD/CDD over that month's days, from the account's cached
// daily history (day-of-year normals). No forecast: a year out there is none, so
// every day is sourced from normals (or the overall mean as a last resort).
//
// FAILURE-TOLERANT BY DESIGN: never throws. A month we can't source any normal
// for (no history at all) is simply omitted from the map — projectSeason() then
// falls back to that month's same-month-last-year usage. Returns an empty map
// when there's no usable history, which makes the whole season fall back cleanly.
export async function seasonNormalsByMonth(
  accountId: number,
  latestYm: number,
  baseF: number
): Promise<Map<number, ExpectedDegreeDays>> {
  const out = new Map<number, ExpectedDegreeDays>();
  try {
    const dailyRows = await prisma.weatherDaily.findMany({
      where: { accountId },
      select: { date: true, tMean: true },
      orderBy: { date: 'asc' },
    });
    const history = dailyRows.map((d) => ({ date: ymd(d.date), tMean: d.tMean }));
    const normals = dayOfYearNormals(history);
    const overall = overallMean(history);
    if (!normals.size && overall == null) return out; // no usable history

    for (let h = 1; h <= 12; h++) {
      const ym = ymAddMonths(latestYm, h);
      const days = daysInRange(ymMonthStart(ym), ymMonthEnd(ym));
      // No forecast slice for a year-out month — assemble entirely from normals.
      const edd = assembleExpectedDegreeDays(days, [], normals, overall, baseF);
      // Only keep a month we could actually source normals for every (or any) day.
      if (edd.normalDays > 0) out.set(ym, edd);
    }
  } catch {
    // Be resilient: any read error -> empty map -> season falls back cleanly.
    return out;
  }
  return out;
}
