-- Historical weather from a dedicated provider (Open-Meteo), full bill history.
-- Adds cached geocode coords to Account, a `source` discriminator + widened
-- unique key on the monthly Weather model, and a new daily WeatherDaily table
-- (degree-days in issue #5 roll HDD/CDD per bill period from these daily rows).

-- Account: cache the geocoded lat/lon so we geocode at most once.
ALTER TABLE "Account" ADD COLUMN "latitude" DOUBLE PRECISION;
ALTER TABLE "Account" ADD COLUMN "longitude" DOUBLE PRECISION;

-- Weather: distinguish NG's ~24-month feed ("ng", fallback) from the Open-Meteo
-- full-history rollup ("open-meteo", primary) so both can coexist per month.
ALTER TABLE "Weather" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'ng';

-- The unique key now includes source. Drop the old (region, monthYear) key and
-- replace it with (region, monthYear, source).
DROP INDEX IF EXISTS "Weather_region_monthYear_key";
CREATE UNIQUE INDEX "Weather_region_monthYear_source_key" ON "Weather"("region", "monthYear", "source");

-- WeatherDaily: per-day temps from Open-Meteo, scoped to the geocoded account.
CREATE TABLE "WeatherDaily" (
    "id" SERIAL NOT NULL,
    "accountId" INTEGER NOT NULL,
    "date" DATE NOT NULL,
    "tMean" DOUBLE PRECISION NOT NULL,
    "tMin" DOUBLE PRECISION,
    "tMax" DOUBLE PRECISION,
    "unit" TEXT NOT NULL DEFAULT 'F',
    "source" TEXT NOT NULL DEFAULT 'open-meteo',

    CONSTRAINT "WeatherDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WeatherDaily_accountId_date_source_key" ON "WeatherDaily"("accountId", "date", "source");
CREATE INDEX "WeatherDaily_accountId_date_idx" ON "WeatherDaily"("accountId", "date");

ALTER TABLE "WeatherDaily" ADD CONSTRAINT "WeatherDaily_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
