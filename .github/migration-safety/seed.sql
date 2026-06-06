-- Representative data for the migration-safety check (.github/workflows).
-- It is loaded into a database running the PREVIOUS release's schema, then the
-- current schema is applied with `prisma db push` to prove an upgrade preserves
-- existing rows. Cover every table that can hold real data, with the kinds of
-- values production has (a carried-balance bill, supply+delivery costs, a weather
-- row, settings, a scrape run, a schedule). Insert only into long-stable columns
-- so the seed stays valid against any prior release's schema.

INSERT INTO "Account"(id,"accountNumber","region","companyCode","serviceAddress","fuelTypes","firstSeenAt","updatedAt")
VALUES (1,'ACC-123','UNY','NIMO','1 Test St, Albany NY 12207','{ELECTRIC,GAS}',now(),now());

INSERT INTO "Bill"(id,"accountId","statementDate","periodFrom","periodTo","totalDueAmount","currentCharges","status","pdfPath","createdAt")
VALUES (10,1,'2026-04-01','2026-03-01','2026-03-31',207.46,205.37,'PAID','/data/pdfs/2026-04-01.pdf',now()),
       (11,1,'2026-05-01','2026-04-01','2026-04-30',150.00,150.00,'DUE',NULL,now());

INSERT INTO "Usage"(id,"accountId","usageType","periodYearMonth","quantity","unit")
VALUES (20,1,'TOTAL_KWH',202604,500,'kWh'),(21,1,'THERMS',202604,40,'therms');

INSERT INTO "Cost"(id,"accountId","fuelType","kind","periodYearMonth","amount")
VALUES (30,1,'ELECTRIC','SUPPLY',202604,40),(31,1,'ELECTRIC','DELIVERY',202604,60);

INSERT INTO "Weather"(id,"region","monthYear","avgTemperature","unit")
VALUES (40,'UNY','2026-04-01',55.0,'F');

INSERT INTO "AppSetting"(key,value) VALUES ('schedulerEnabled','true');

INSERT INTO "ScrapeRun"(id,"accountId","trigger","status","startedAt","billsAdded","message")
VALUES (50,1,'MANUAL','SUCCESS',now(),2,'seed run');

INSERT INTO "ScheduleState"("accountId","predictedNextBillDate","nextCheckAt","lastCheckedAt")
VALUES (1,'2026-06-01',now(),now());
