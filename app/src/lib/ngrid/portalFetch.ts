// Reusable National Grid portal HTTP helpers, carved out of collect.ts so the
// Scheduler V2 task handlers (step 5) can run the PDF-download and AMI-interval
// fetches against a shared PortalSession instead of only inside the monolithic
// collect(). These are STRICTLY behavior-preserving relocations of the code that
// used to live inline in collectOneAccount() — same headers, timeouts, retries,
// settle delays, and control flow.
//
// Step 2 NOTE: collect() now calls these; nothing else does yet.
import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { dataDir } from './auth';
import { parseBillPdf } from './parsePdf';
import {
  amiEnergyUsagesBody,
  amiIntervalUrl,
  backfillStartFor,
  backwardChunks,
  extractAmiMeters,
  intervalDateWindow,
  parseAmiEnergyUsages,
  parseIntervalReads,
  unitForFuel,
  type IntervalReadRow,
} from './interval';
import type { AccountInfo, BillRow, CostRow, ProgressFn } from './types';

const BASE = 'https://myaccount.nationalgrid.com';

// First-run deep pull of ALL available HOURLY interval history for a brand-new
// account (no stored interval rows yet, no env override): we page BACKWARD from
// now in 31-day chunks until the meter runs dry (2 consecutive empty chunks),
// discovering the full history regardless of meter age — no arbitrary day cap.
// After the first run the account has rows, so subsequent scrapes use the normal
// tail window. INTERVAL_BACKFILL_FROM (when set) still overrides everything.
//
// Safety ceiling ONLY (not a data cap): ~20 years bounds the backward paging so a
// misbehaving endpoint can never loop forever. If we ever hit it we log it.
const MAX_BACKFILL_DAYS = 20 * 365;

// Format a Date as the energy-usage gql `YYYY-MM-DD` (UTC fields), matching
// interval.ts's window formatting — used to page a wide gas backfill in chunks.
const fmtGqlDate = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

const yyyymm = (d?: string): number => {
  if (!d) return 0;
  const m = d.match(/^(\d{4})-(\d{2})/);
  return m ? parseInt(m[1], 10) * 100 + parseInt(m[2], 10) : 0;
};

// ---- download new PDFs --------------------------------------------------
// Download any not-yet-stored bill PDFs for `accountNumber` using the captured
// auth headers (+ the PDF-specific `account-number` header), then parse each into
// the per-fuel supply/delivery breakdown + current charges. MUTATES the passed
// `bills` rows in place (sets pdfPath / currentCharges) — collect() relies on the
// mutated bills afterward. Returns the collected cost rows + download/parse counts.
export async function downloadBillPdfs(
  ctx: BrowserContext,
  page: Page,
  args: {
    accountNumber: string;
    authHeaders: Record<string, string>;
    bills: BillRow[];
    log: ProgressFn;
  }
): Promise<{ costRows: CostRow[]; pdfsDownloaded: number; parseFailures: number }> {
  const { accountNumber, authHeaders, bills, log } = args;
  const costRows: CostRow[] = [];
  let pdfsDownloaded = 0;
  let parseFailures = 0;
  const pdfDir = path.join(dataDir(), 'pdfs', accountNumber);
  fs.mkdirSync(pdfDir, { recursive: true });
  const headers = { ...authHeaders, 'account-number': accountNumber };
  log(`downloading PDFs (${bills.length} bills)`);
  for (const b of bills) {
    const dest = path.join(pdfDir, `${b.statementDate}.pdf`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      b.pdfPath = dest;
    } else {
      const url = `${BASE}/api/bill-cu-uwp-sys/v1/bills/view-pdf/${b.statementDate}`;
      let saved = false;
      for (let attempt = 1; attempt <= 3 && !saved; attempt++) {
        try {
          const r = await ctx.request.get(url, { headers, timeout: 30000 });
          const ctype = (r.headers()['content-type'] || '').toLowerCase();
          if (r.ok() && ctype.includes('pdf')) {
            fs.writeFileSync(dest, await r.body());
            b.pdfPath = dest;
            saved = true;
            pdfsDownloaded++;
          } else if (r.status() < 500) {
            break;
          }
        } catch {
          await page.waitForTimeout(1200);
        }
      }
    }

    // Parse the per-fuel supply/delivery breakdown + period charges from the PDF.
    if (b.pdfPath) {
      const d = await parseBillPdf(b.pdfPath);
      if (d) {
        b.currentCharges = d.currentCharges ?? undefined;
        const ym = yyyymm(b.statementDate);
        const add = (fuelType: string, kind: 'SUPPLY' | 'DELIVERY', amount: number | null) => {
          if (amount != null) costRows.push({ fuelType, kind, periodYearMonth: ym, dateFrom: b.periodFrom, dateTo: b.periodTo, amount });
        };
        add('ELECTRIC', 'SUPPLY', d.electric.supply);
        add('ELECTRIC', 'DELIVERY', d.electric.delivery);
        add('GAS', 'SUPPLY', d.gas.supply);
        add('GAS', 'DELIVERY', d.gas.delivery);
      } else {
        parseFailures++;
      }
    }
  }
  if (parseFailures) log(`warning: ${parseFailures} PDFs had no parseable breakdown`);
  return { costRows, pdfsDownloaded, parseFailures };
}

// ---- smart-meter AMI interval reads (issue #76 / #121) ------------------
// Capture interval usage at BOTH grains, reusing the captured auth headers
// (same gateway as the PDF download — no account-number header here, that's
// PDF-specific). PURELY observational: these rows NEVER feed billed-cost
// numbers (AGENTS.md rule #1).
//
// Two coexisting sources per meter (issue #121):
//   (a) HOURLY gql backstop — ALWAYS run. The `amiEnergyUsages` query serves a
//       WIDE range for BOTH fuels (electric returns hourly here; gas only works
//       here), paged in ≤31-day chunks over the INTERVAL_WINDOW_DAYS window.
//       This is the gap-free continuous-hourly feed for every meter.
//   (b) 15-min REST overlay — BEST-EFFORT additional capture. The `amiadapter`
//       REST endpoint returns 15-minute electric reads but only for a SHORT
//       window (~2 days; it 400s on longer ranges, and gas 404s entirely). A
//       non-2xx here is fine — the gql backstop already covered the meter
//       hourly — so we skip silently with a log.
// The two grains share `IntervalUsage`'s unique key (which includes
// intervalSeconds: 900 vs 3600) and persist is a fill-only upsert, so storing
// both is safe and non-destructive; the read layer reconciles them.
//
// Good-guest (rule #4): AMI-gated per meter, SEQUENTIAL, bounded (one gql
// window-set + one short REST per meter per run), no retry storm, with the
// existing settle delays. Fully try/catch-wrapped — a failure of EITHER call
// can never break the scrape.
export async function fetchAmiIntervals(
  ctx: BrowserContext,
  page: Page,
  args: {
    acct: AccountInfo;
    rawAccount: any;
    authHeaders: Record<string, string>;
    haveAuth: boolean;
    accountNumber: string;
    hasIntervalData?: (n: string) => Promise<boolean>;
    log: ProgressFn;
  }
): Promise<IntervalReadRow[]> {
  const { acct, rawAccount, authHeaders, haveAuth, accountNumber, hasIntervalData, log } = args;
  const intervals: IntervalReadRow[] = [];
  try {
    const meters = extractAmiMeters(rawAccount);
    if (!haveAuth) {
      log('interval: no auth headers; skipping AMI interval fetch');
    } else if (!meters.length) {
      log('interval: no AMI smart meter on this account; skipping interval fetch');
    } else if (!acct.premiseNumber) {
      log('interval: no premise number; skipping interval fetch');
    } else {
      // Narrowed non-null above; capture for use inside the fetchChunk closure
      // (TS doesn't carry the narrowing into a nested function body).
      const premiseNumber = acct.premiseNumber;
      const windowDays = Number.parseInt(process.env.INTERVAL_WINDOW_DAYS || '', 10);
      const effectiveWindowDays = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 35;
      // First-run detection: a brand-new account (no stored interval rows) gets a
      // one-time DEEP hourly backfill — pages BACKWARD until the meter runs dry —
      // WITHOUT the operator setting any env var. The probe is injected (collect.ts
      // stays DB-free); omitted or failing → safe default "has data" (normal tail).
      let isFirstIntervalRun = false;
      if (hasIntervalData) {
        try {
          isFirstIntervalRun = !(await hasIntervalData(accountNumber));
        } catch {
          isFirstIntervalRun = false; // probe failure → safe default: normal tail
        }
      }
      // The deep first-run backfill only kicks in WITHOUT an env override
      // (INTERVAL_BACKFILL_FROM is the operator's explicit floor and still wins
      // via intervalDateWindow's forward-chunked window below).
      const hasEnvOverride = !!process.env.INTERVAL_BACKFILL_FROM;
      const deepBackfill = isFirstIntervalRun && !hasEnvOverride;
      // Short window for the 15-min REST overlay — kept small so the amiadapter
      // endpoint actually returns 15-min reads (it 400s on a long range); the
      // hourly gql above is the wide backstop. Default 2 days.
      const restWindowParsed = Number.parseInt(process.env.INTERVAL_REST_WINDOW_DAYS || '', 10);
      const restWindowDays = Number.isFinite(restWindowParsed) && restWindowParsed > 0 ? restWindowParsed : 2;
      const restStartDateTime = backfillStartFor(
        new Date(),
        null, // lastStored unknown here; persist's upsert makes re-fetch idempotent
        undefined, // the wide backfill is the gql's job; the REST overlay stays short
        restWindowDays
      );
      // Per-request span cap for the gql backstop (the gateway caps the range);
      // a wider backfill is paged in ≤ MAX_GQL_SPAN_DAYS chunks. The default tail
      // window is a single chunk.
      const MAX_GQL_SPAN_DAYS = 31;
      const DAY_MS = 24 * 60 * 60 * 1000;
      for (const meter of meters) {
        let gqlRows = 0;
        let restRows = 0;
        try {
          // 1) HOURLY gql backstop — ALWAYS run (both fuels). Two windowing modes,
          //    both paged in ≤31-day chunks (sequential, with the existing settle
          //    delay) so we stay a good guest:
          //      - DEEP first-run backfill: page BACKWARD (newest→oldest) from now
          //        until the meter runs dry (2 consecutive empty chunks), bounded by
          //        the MAX_BACKFILL_DAYS safety ceiling. Discovers the full history.
          //      - Otherwise (steady-state tail, OR an INTERVAL_BACKFILL_FROM floor):
          //        the forward-chunked [dateFrom, dateTo] window from
          //        intervalDateWindow (default tail is a single chunk).
          log(`interval: fetching ${meter.fuelType} hourly gql (sp ${meter.servicePointNumber})`);

          // POST one [from, to] chunk, parse + collect rows, return how many rows
          // it yielded (so the backward pager can detect empty windows).
          const fetchChunk = async (chunkFrom: string, chunkTo: string): Promise<number> => {
            const gqlResp = await ctx.request.post(`${BASE}/api/energyusage-cu-uwp-gql`, {
              headers: { ...authHeaders, 'content-type': 'application/json' },
              data: amiEnergyUsagesBody(meter, premiseNumber, chunkFrom, chunkTo),
              timeout: 30000,
            });
            if (!gqlResp.ok()) {
              log(`interval: ${meter.fuelType} gql ${chunkFrom}..${chunkTo} HTTP ${gqlResp.status()}`);
              return 0;
            }
            const gjson = (await gqlResp.json().catch(() => null)) as {
              data?: { amiEnergyUsages?: { nodes?: unknown } };
            } | null;
            const nodes = gjson?.data?.amiEnergyUsages?.nodes;
            if (!Array.isArray(nodes)) {
              log(`interval: ${meter.fuelType} gql ${chunkFrom}..${chunkTo} had no nodes`);
              return 0;
            }
            const rows = parseAmiEnergyUsages(
              nodes as Array<{ date: string; fuelType?: string; quantity: number }>,
              meter.fuelType
            );
            intervals.push(...rows);
            gqlRows += rows.length;
            return rows.length;
          };

          let chunks = 0;
          if (deepBackfill) {
            // DEEP first-run discovery: page backward until 2 CONSECUTIVE chunks
            // return zero rows (a single empty 31-day window can be a legit gap,
            // e.g. a move-out, so require two in a row before concluding we're
            // before the meter install). The window math is the pure
            // backwardChunks(); the stop condition needs the live responses.
            log(`interval: first run for ${meter.fuelType} — discovering full hourly history (paging backward until dry)`);
            const windows = backwardChunks(new Date(), MAX_GQL_SPAN_DAYS, MAX_BACKFILL_DAYS);
            let consecutiveEmpty = 0;
            for (const w of windows) {
              const got = await fetchChunk(w.from, w.to);
              chunks++;
              consecutiveEmpty = got === 0 ? consecutiveEmpty + 1 : 0;
              if (consecutiveEmpty >= 2) break;
              if (chunks >= windows.length) {
                log(`interval: ${meter.fuelType} hit MAX_BACKFILL_DAYS safety ceiling (${MAX_BACKFILL_DAYS}d) before running dry`);
                break;
              }
              // Settle between chunks (good guest).
              await page.waitForTimeout(1500).catch(() => {});
            }
          } else {
            // Steady-state tail (or an INTERVAL_BACKFILL_FROM floor): forward-chunk
            // the [dateFrom, dateTo] window. The default tail is a single chunk.
            const { dateFrom, dateTo } = intervalDateWindow(
              new Date(),
              process.env.INTERVAL_BACKFILL_FROM,
              effectiveWindowDays
            );
            const fromMs = Date.parse(dateFrom);
            const toMs = Date.parse(dateTo);
            let chunkStart = Number.isFinite(fromMs) ? fromMs : toMs;
            const endMs = Number.isFinite(toMs) ? toMs : chunkStart;
            while (chunkStart <= endMs) {
              const chunkEnd = Math.min(chunkStart + MAX_GQL_SPAN_DAYS * DAY_MS, endMs);
              const chunkFrom = fmtGqlDate(new Date(chunkStart));
              const chunkTo = fmtGqlDate(new Date(chunkEnd));
              await fetchChunk(chunkFrom, chunkTo);
              chunks++;
              if (chunkEnd >= endMs) break;
              chunkStart = chunkEnd + DAY_MS;
              // Settle between chunks (good guest).
              await page.waitForTimeout(1500).catch(() => {});
            }
          }

          // 2) 15-min REST overlay — best-effort. SHORT window so the amiadapter
          //    endpoint returns 15-minute reads. A non-2xx (gas 404s; electric on
          //    a bad range 400s) is expected and harmless: the gql above already
          //    covered this meter hourly, so we skip silently with a log.
          await page.waitForTimeout(1500).catch(() => {});
          const url = amiIntervalUrl(BASE, acct.premiseNumber, meter.servicePointNumber, restStartDateTime);
          const r = await ctx.request.get(url, { headers: authHeaders, timeout: 30000 });
          if (r.ok()) {
            const json = await r.json().catch(() => null);
            if (Array.isArray(json)) {
              const rows = parseIntervalReads(json, meter.fuelType, unitForFuel(meter.fuelType));
              intervals.push(...rows);
              restRows += rows.length;
            } else {
              log(`interval: ${meter.fuelType} REST response was not an array; skipping`);
            }
          } else {
            log(
              `interval: ${meter.fuelType} 15-min REST HTTP ${r.status()} (expected for gas / long range) — hourly gql already captured this meter`
            );
          }

          log(`interval: ${meter.fuelType} — 15-min REST ${restRows}, hourly gql ${gqlRows}`);
        } catch (err) {
          log(`interval: ${meter.fuelType} fetch failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        // Keep the per-request settle rhythm so we stay a good guest.
        await page.waitForTimeout(1500).catch(() => {});
      }
    }
  } catch (err) {
    log(`interval: AMI ingest skipped (${err instanceof Error ? err.message : String(err)})`);
  }
  return intervals;
}
