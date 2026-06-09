// Pure heating/cooling degree-day math. Degree-days weather-normalize usage: a
// colder month racks up more Heating Degree-Days (HDD), a hotter one more Cooling
// Degree-Days (CDD), so dividing usage by degree-days gives a weather-independent
// "per degree-day" intensity. This is the only place the HDD/CDD arithmetic lives;
// it's PURE so the hand-calculated test exercises it directly.

export interface DegreeDays {
  hdd: number; // sum of max(0, base - tMean) over the days
  cdd: number; // sum of max(0, tMean - base) over the days
  days: number; // number of daily samples summed
}

// Sum HDD/CDD over a list of daily mean temperatures against a balance point.
// Per day: HDD = max(0, base - tMean), CDD = max(0, tMean - base). A day exactly
// at the base contributes 0 to both. Default base is 65°F (the US convention).
// PURE.
export function sumDegreeDays(
  daily: { date: string; tMean: number }[],
  baseF = 65
): DegreeDays {
  let hdd = 0;
  let cdd = 0;
  for (const d of daily) {
    hdd += Math.max(0, baseF - d.tMean);
    cdd += Math.max(0, d.tMean - baseF);
  }
  return { hdd, cdd, days: daily.length };
}
