// Drive a headless browser to collect the full bill/usage/cost/weather history.
// Strategy (proven): intercept the SPA's own GraphQL requests and only widen
// their date/paging filters, which preserves the app's auth + subscription-key
// headers. Then download any new bill PDFs with those captured headers.
//
// Step 2 (multi-account): a single login can expose several billing accounts,
// each addressed by an opaque `accountLink` slug. After login we discover the
// full set of links from the portal's account list, then scrape EACH through
// the same dashboard → bill-history → energy-usage flow — SEQUENTIALLY, reusing
// the one logged-in session (never parallel; keep the per-page settle waits so
// we stay a good guest). `collect()` therefore returns one CollectResult per
// account. Discovering one account is the common case and behaves exactly as
// before.
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import type { Page, Route } from 'playwright';
import { contextOptions, ensureLoggedIn, dataDir, saveState } from './auth';
import { extractAccountLinks, buildNavUrl } from './accounts';
import { parseBillPdf } from './parsePdf';
import { summarizeGqlRequest, summarizeGqlResponse } from './intervalDebug';
import {
  amiEnergyUsagesBody,
  amiIntervalUrl,
  backfillStartFor,
  extractAmiMeters,
  intervalDateWindow,
  parseAmiEnergyUsages,
  parseIntervalReads,
  unitForFuel,
  type IntervalReadRow,
} from './interval';
import type {
  AccountInfo,
  BillRow,
  CollectResult,
  CostRow,
  ProgressFn,
  UsageRow,
  WeatherRow,
} from './types';

export interface CollectOptions {
  // The stored NgLogin these accounts are scraped under; tagged onto each
  // CollectResult so persist() can set Account.loginId. Omit for env scrapes.
  loginId?: number;
}

const BASE = 'https://myaccount.nationalgrid.com';

// Format a Date as the energy-usage gql `YYYY-MM-DD` (UTC fields), matching
// interval.ts's window formatting — used to page a wide gas backfill in chunks.
const fmtGqlDate = (d: Date): string => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};

const asArray = (x: any): any[] => (Array.isArray(x?.nodes) ? x.nodes : Array.isArray(x) ? x : []);
const ymd = (d?: string): string | undefined => (d ? d.slice(0, 10) : undefined);
const yyyymm = (d?: string): number => {
  if (!d) return 0;
  const m = d.match(/^(\d{4})-(\d{2})/);
  return m ? parseInt(m[1], 10) * 100 + parseInt(m[2], 10) : 0;
};
const unitFor = (usageType: string): string =>
  /KWH/i.test(usageType) ? 'kWh' : /THERM/i.test(usageType) ? 'therms' : '';

export async function collect(
  log: ProgressFn = () => {},
  opts: CollectOptions = {}
): Promise<CollectResult[]> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext(contextOptions(opts.loginId));
  const page = await ctx.newPage();

  try {
    await ensureLoggedIn(page, log, opts.loginId);
    // The link the portal landed on after login is our default/first account and
    // the fallback if discovery turns up nothing.
    const defaultLink = new URL(page.url()).searchParams.get('accountLink') || undefined;

    // ---- discover all accountLinks for this login --------------------------
    // The dashboard's account list (the OpowerAccount / billingaccount-cu-uwp-gql
    // op, or the `user` payload behind the account switcher) carries every linked
    // billing account. Capture those payloads on a dashboard visit, then parse
    // out the link slugs. If introspection/enumeration ever stops working we
    // still have `defaultLink`, so the scrape degrades to single-account.
    const discoveryPayloads: any[] = [];
    const onDiscovery = async (resp: import('playwright').Response) => {
      const url = resp.url();
      if (!/\/api\/[a-z-]+-gql/.test(url)) return;
      try {
        const json = await resp.json();
        if (json?.data) discoveryPayloads.push(json.data);
      } catch {
        /* not JSON / not interesting */
      }
    };
    page.on('response', onDiscovery);
    log('discovering linked accounts');
    await page.goto(buildNavUrl(BASE, '/dashboard', defaultLink), { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(4000);
    page.off('response', onDiscovery);

    const accountLinks = extractAccountLinks(discoveryPayloads, defaultLink);
    // Keep at least one entry so a login whose list we couldn't read still
    // scrapes its default account (undefined link = portal's current account).
    const links: (string | undefined)[] = accountLinks.length ? accountLinks : [undefined];
    log(`found ${links.length} account(s): ${links.map((l) => l ?? '(default)').join(', ')}`);

    // Re-save in case discovery refreshed tokens.
    await saveState(ctx, opts.loginId).catch(() => {});

    // ---- scrape each account sequentially ----------------------------------
    const results: CollectResult[] = [];
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      log(`scraping account ${i + 1}/${links.length}${link ? ` (${link})` : ''}`);
      const result = await collectOneAccount(page, ctx, link, log, opts.loginId);
      result.loginId = opts.loginId;
      results.push(result);
    }
    return results;
  } finally {
    await browser.close();
  }
}

// Scrape a single billing account identified by `accountLink` (undefined = the
// account the portal currently sits on). Attaches the intercept-and-widen route
// + response capture, walks dashboard → bill-history → energy-usage, downloads
// any new PDFs, and returns the normalized CollectResult. Detaches its handlers
// on the way out so the next account in the loop starts clean.
async function collectOneAccount(
  page: Page,
  ctx: import('playwright').BrowserContext,
  accountLink: string | undefined,
  log: ProgressFn,
  loginId: number | undefined
): Promise<CollectResult> {
  // Capture buckets (per-account).
  const cap: Record<string, any> = {};
  const authHeaders: Record<string, string> = {};
  let haveAuth = false;
  let accountNumber: string | undefined;
  let companyCode: string | undefined;
  let weatherRegion: string | undefined;

  // SCRAPE_DEBUG-only discovery buffer (issue #76, phase 1). Holds summarized
  // gql requests + responses observed during this account's scrape so we can dump
  // them to a debug artifact at the end. Stays empty (and is never written) when
  // SCRAPE_DEBUG is unset, so the normal path is byte-identical.
  type DebugEntry =
    | { kind: 'request'; entry: NonNullable<ReturnType<typeof summarizeGqlRequest>> }
    | { kind: 'response'; entry: ReturnType<typeof summarizeGqlResponse> };
  const debugLog: DebugEntry[] = [];

  // Widen filters + capture auth headers / identifiers from the app's requests.
  const onRoute = async (route: Route) => {
    const req = route.request();
    const h = req.headers();
    let post = req.postData() || '';
    // Capture the ORIGINAL request body (what the SPA actually sent) before we
    // widen anything below — debug-only, never alters the widening.
    if (process.env.SCRAPE_DEBUG) {
      try {
        const summary = summarizeGqlRequest(req.url(), post);
        if (summary) debugLog.push({ kind: 'request', entry: summary });
      } catch {
        /* debug capture must never affect the scrape */
      }
    }
    try {
      const j = JSON.parse(post);
      const v = j.variables || {};
      if (v.accountNumber) accountNumber = v.accountNumber;
      if (v.companyCode) companyCode = v.companyCode;
      if (v.region) weatherRegion = v.region;
      // Widen only the filters we've verified are safe. The bills query takes a
      // floor date; the energy-usage query pages by numeric YYYYMM `from` + `first`.
      // Do NOT touch the weather query's string `from` / `last` — widening those
      // makes that endpoint return an empty set.
      if ('dateForNumberOfDaysAgo' in v) v.dateForNumberOfDaysAgo = '2000-01-01';
      if (typeof v.from === 'number') v.from = 200001; // YYYYMM, far past
      if (typeof v.first === 'number') v.first = 1000;
      j.variables = v;
      post = JSON.stringify(j);
    } catch {
      /* leave body unchanged */
    }
    if (!haveAuth && h.authorization && h['ocp-apim-subscription-key']) {
      authHeaders.authorization = h.authorization;
      authHeaders['ocp-apim-subscription-key'] = h['ocp-apim-subscription-key'];
      authHeaders.origin = BASE;
      haveAuth = true;
    }
    await route.continue({ postData: post });
  };

  // Capture responses by their data keys.
  const onResponse = async (resp: import('playwright').Response) => {
    const url = resp.url();
    if (!/\/api\/[a-z-]+-gql/.test(url)) return;
    let json: any;
    try {
      json = await resp.json();
    } catch {
      return;
    }
    const data = json?.data;
    if (!data) return;
    if (process.env.SCRAPE_DEBUG) {
      console.log('[collect] gql keys:', Object.keys(data).join('+'));
      // Record EVERY gql response (not just the known cap.* keys) so the spike
      // can surface the MySmartEnergy interval payload alongside the rest.
      try {
        debugLog.push({ kind: 'response', entry: summarizeGqlResponse(url, data) });
      } catch {
        /* debug capture must never affect the scrape */
      }
    }
    if (data.Bills) cap.bills = asArray(data.Bills);
    if (data.energyUsages) cap.usages = asArray(data.energyUsages);
    if (data.energyUsageCosts) cap.costs = asArray(data.energyUsageCosts);
    if (data.energyUsageBillAmounts) cap.billAmounts = asArray(data.energyUsageBillAmounts);
    if (data.weather) cap.weather = asArray(data.weather);
    if (data.billingAccount) cap.account = data.billingAccount;
    if (data.user) cap.user = data.user;
  };

  await page.route('**/api/**-gql', onRoute);
  page.on('response', onResponse);

  try {
    const q = accountLink;
    // Visit each data page WITH the capture handlers attached. The dashboard is
    // re-visited here because some queries (weather, per-fuel bill amounts) fire
    // on it and would otherwise be missed during the initial login navigation.
    for (const [name, routePath] of [
      ['dashboard', '/dashboard'],
      ['bill history', '/bill-history'],
      ['energy usage', '/energy-usage'],
    ] as const) {
      log(`loading ${name}`);
      await page.goto(buildNavUrl(BASE, routePath, q), { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(4000);
    }
    // ---- SCRAPE_DEBUG: interval-view discovery probe (issue #76, phase 1) ----
    // Try to make the MySmartEnergy interval query fire on /energy-usage so the
    // debug artifact captures its query key + variable shape. Best-effort and
    // FULLY exception-wrapped end to end — a debug run must never crash a scrape.
    // Bounded clicks, sequential, with the existing per-page settle waits: still
    // a good guest. Entirely inert when SCRAPE_DEBUG is unset.
    if (process.env.SCRAPE_DEBUG) {
      try {
        log('interval-spike: probing energy-usage interval view');
        await page
          .goto(buildNavUrl(BASE, '/energy-usage', q), { waitUntil: 'networkidle', timeout: 30000 })
          .catch(() => {});
        await page.waitForTimeout(3500).catch(() => {});

        // Click up to ~5 distinct controls that look like a granularity / interval
        // drill-down. Each click is independently wrapped so a stale/missing
        // control can't throw out of the probe.
        const intervalRe = /15[\s-]?min|interval|hourly|daily|\bday\b|\bhour\b|usage detail|my\s*smart\s*energy/i;
        const seen = new Set<string>();
        let clicks = 0;
        for (const sel of ['button', 'a', '[role="tab"]', '[role="button"]', '.tab']) {
          if (clicks >= 5) break;
          let loc;
          try {
            loc = page.locator(sel).filter({ hasText: intervalRe });
          } catch {
            continue;
          }
          let count = 0;
          try {
            count = await loc.count();
          } catch {
            count = 0;
          }
          for (let i = 0; i < count && clicks < 5; i++) {
            try {
              const el = loc.nth(i);
              const text = ((await el.innerText({ timeout: 1500 }).catch(() => '')) || '').trim().toLowerCase();
              const key = `${sel}::${text}`;
              if (text && seen.has(key)) continue;
              if (text) seen.add(key);
              await el.click({ timeout: 3000 });
              clicks++;
              await page.waitForTimeout(3500).catch(() => {});
            } catch {
              /* stale / not clickable — skip */
            }
          }
        }

        // Optional operator override: point straight at the interval URL if the
        // clicks don't surface it. Path → buildNavUrl; otherwise treated as raw.
        const overrideUrl = process.env.INTERVAL_DEBUG_URL;
        if (overrideUrl) {
          try {
            const target = overrideUrl.startsWith('/') ? buildNavUrl(BASE, overrideUrl, q) : overrideUrl;
            log(`interval-spike: navigating override ${target}`);
            await page.goto(target, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
            await page.waitForTimeout(3500).catch(() => {});
          } catch {
            /* override navigation is best-effort */
          }
        }
      } catch {
        /* the entire interval probe is best-effort — never break the scrape */
      }

      // ---- write the debug artifact -------------------------------------
      try {
        const requests = debugLog.filter((e) => e.kind === 'request').map((e) => e.entry);
        const responses = debugLog.filter((e) => e.kind === 'response').map((e) => e.entry);
        const dir = process.env.BACKUP_DIR || path.join(dataDir(), 'backups');
        fs.mkdirSync(dir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const outPath = path.join(dir, `interval-spike-${accountNumber || 'unknown'}-${ts}.json`);
        fs.writeFileSync(
          outPath,
          JSON.stringify({ capturedAt: new Date().toISOString(), accountNumber, requests, responses }, null, 2)
        );
        const keysSeen = [...new Set(responses.flatMap((r) => r.keys))].join(', ');
        console.log(
          `[collect] interval-spike: wrote ${outPath} (${requests.length} gql requests, ${responses.length} responses, response keys seen: ${keysSeen})`
        );
      } catch (err) {
        console.log('[collect] interval-spike: failed to write artifact:', err);
      }
    }

    // Re-save session in case tokens were refreshed during navigation.
    await saveState(ctx, loginId).catch(() => {});
  } finally {
    await page.unroute('**/api/**-gql', onRoute);
    page.off('response', onResponse);
  }

  if (!accountNumber) throw new Error('Could not determine the account number from the portal.');

  // ---- normalize ---------------------------------------------------------
  const rawAddr = cap.account?.serviceAddress;
  const serviceAddress =
    typeof rawAddr === 'string'
      ? rawAddr
      : rawAddr?.serviceAddressCompressed ||
        rawAddr?.compressed ||
        (rawAddr ? JSON.stringify(rawAddr) : undefined);
  const fuelTypes = (Array.isArray(cap.account?.fuelTypes) ? cap.account.fuelTypes : [])
    .map((f: any) => (typeof f === 'string' ? f : f?.type))
    .filter(Boolean);

  const acct: AccountInfo = {
    accountNumber,
    accountLink,
    companyCode,
    region: cap.account?.region || weatherRegion,
    serviceAddress,
    fuelTypes,
    premiseNumber: cap.account?.premiseNumber ? String(cap.account.premiseNumber) : undefined,
    customerNumber: cap.account?.customerNumber ? String(cap.account.customerNumber) : undefined,
  };

  const bills: BillRow[] = (cap.bills || []).map((b: any) => ({
    statementDate: ymd(b.statementDate)!,
    periodFrom: ymd(b.billDuration?.fromDate),
    periodTo: ymd(b.billDuration?.toDate),
    totalDueAmount: typeof b.totalDueAmount === 'number' ? b.totalDueAmount : undefined,
    status: b.status,
    usageTypes: asArray(b.energyUsages).map((n: any) => n.usageType).filter(Boolean),
  }));

  const usage: UsageRow[] = (cap.usages || []).map((u: any) => ({
    usageType: u.usageType,
    periodYearMonth: typeof u.usageYearMonth === 'number' ? u.usageYearMonth : yyyymm(u.dateFrom),
    dateFrom: ymd(u.dateFrom),
    dateTo: ymd(u.dateTo),
    quantity: Number(u.usage) || 0,
    unit: unitFor(u.usageType),
  }));

  // Per-fuel supply/delivery costs come from the bill PDFs (full history) — the
  // API's energyUsageCosts/energyUsageBillAmounts only cover ~24 months. Built
  // in the PDF loop below.
  const costRows: CostRow[] = [];

  // Weather has one row per fuelType per month; collapse to one temp per month.
  const weatherByMonth = new Map<string, WeatherRow>();
  for (const w of cap.weather || []) {
    const monthYear = ymd(w.applicableMonthYear);
    if (!monthYear) continue;
    if (!weatherByMonth.has(monthYear))
      weatherByMonth.set(monthYear, {
        region: w.region || weatherRegion || acct.region || 'UNKNOWN',
        monthYear,
        avgTemperature: Number(w.averageTemperature),
        unit: w.measureUnit || 'F',
      });
  }
  const weather = [...weatherByMonth.values()];

  // ---- download new PDFs --------------------------------------------------
  let pdfsDownloaded = 0;
  let parseFailures = 0;
  if (haveAuth) {
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
  } else {
    log('warning: no auth headers captured; skipping PDF download');
  }

  // ---- smart-meter AMI interval reads (issue #76) -------------------------
  // Pull recent interval usage from the amiadapter REST endpoint, reusing the
  // captured auth headers (same gateway as the PDF download — no account-number
  // header here, that's PDF-specific). PURELY observational: these rows NEVER
  // feed billed-cost numbers (AGENTS.md rule #1). Good-guest (rule #4): AMI-gated
  // per meter, ONE windowed request per meter per run, SEQUENTIAL, no retry storm.
  // Fully try/catch-wrapped so an interval-fetch hiccup can never break a scrape.
  const intervals: IntervalReadRow[] = [];
  try {
    const meters = extractAmiMeters(cap.account);
    if (!haveAuth) {
      log('interval: no auth headers; skipping AMI interval fetch');
    } else if (!meters.length) {
      log('interval: no AMI smart meter on this account; skipping interval fetch');
    } else if (!acct.premiseNumber) {
      log('interval: no premise number; skipping interval fetch');
    } else {
      const windowDays = Number.parseInt(process.env.INTERVAL_WINDOW_DAYS || '', 10);
      const startDateTime = backfillStartFor(
        new Date(),
        null, // lastStored unknown here; persist's upsert makes re-fetch idempotent
        process.env.INTERVAL_BACKFILL_FROM,
        Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 35
      );
      // Per-request span cap for the gql fallback (the gateway caps the range);
      // a wider backfill is paged in ≤ MAX_GQL_SPAN_DAYS chunks. The default tail
      // window is a single chunk.
      const MAX_GQL_SPAN_DAYS = 31;
      const DAY_MS = 24 * 60 * 60 * 1000;
      const effectiveWindowDays = Number.isFinite(windowDays) && windowDays > 0 ? windowDays : 35;
      for (const meter of meters) {
        try {
          // 1) Electric REST first. Self-configuring: electric returns 200/15-min
          //    here; gas 404s on this path and falls through to the gql replay.
          const url = amiIntervalUrl(BASE, acct.premiseNumber, meter.servicePointNumber, startDateTime);
          log(`interval: fetching ${meter.fuelType} reads (sp ${meter.servicePointNumber})`);
          const r = await ctx.request.get(url, { headers: authHeaders, timeout: 30000 });
          if (r.ok()) {
            const json = await r.json().catch(() => null);
            if (Array.isArray(json)) {
              const rows = parseIntervalReads(json, meter.fuelType, unitForFuel(meter.fuelType));
              intervals.push(...rows);
              log(`interval: ${rows.length} ${meter.fuelType} reads via REST since ${startDateTime}`);
            } else {
              log(`interval: ${meter.fuelType} REST response was not an array; skipping`);
            }
          } else {
            // 2) Non-2xx on REST → gas gql fallback on the energy-usage gateway.
            //    Window the [dateFrom, dateTo] range and page it in ≤31-day chunks
            //    (sequential, with the existing settle delay) so a wide backfill
            //    stays a good guest. The default tail is a single window.
            log(`interval: ${meter.fuelType} REST returned HTTP ${r.status()}; trying energy-usage gql`);
            const { dateFrom, dateTo } = intervalDateWindow(
              new Date(),
              process.env.INTERVAL_BACKFILL_FROM,
              effectiveWindowDays
            );
            const fromMs = Date.parse(dateFrom);
            const toMs = Date.parse(dateTo);
            let gqlRows = 0;
            let chunkStart = Number.isFinite(fromMs) ? fromMs : toMs;
            const endMs = Number.isFinite(toMs) ? toMs : chunkStart;
            let chunks = 0;
            while (chunkStart <= endMs) {
              const chunkEnd = Math.min(chunkStart + MAX_GQL_SPAN_DAYS * DAY_MS, endMs);
              const chunkFrom = fmtGqlDate(new Date(chunkStart));
              const chunkTo = fmtGqlDate(new Date(chunkEnd));
              const gqlResp = await ctx.request.post(`${BASE}/api/energyusage-cu-uwp-gql`, {
                headers: { ...authHeaders, 'content-type': 'application/json' },
                data: amiEnergyUsagesBody(meter, acct.premiseNumber, chunkFrom, chunkTo),
                timeout: 30000,
              });
              if (gqlResp.ok()) {
                const gjson = (await gqlResp.json().catch(() => null)) as {
                  data?: { amiEnergyUsages?: { nodes?: unknown } };
                } | null;
                const nodes = gjson?.data?.amiEnergyUsages?.nodes;
                if (Array.isArray(nodes)) {
                  const rows = parseAmiEnergyUsages(
                    nodes as Array<{ date: string; fuelType?: string; quantity: number }>,
                    meter.fuelType
                  );
                  intervals.push(...rows);
                  gqlRows += rows.length;
                } else {
                  log(`interval: ${meter.fuelType} gql ${chunkFrom}..${chunkTo} had no nodes`);
                }
              } else {
                log(`interval: ${meter.fuelType} gql ${chunkFrom}..${chunkTo} HTTP ${gqlResp.status()}`);
              }
              chunks++;
              if (chunkEnd >= endMs) break;
              chunkStart = chunkEnd + DAY_MS;
              // Settle between chunks (good guest).
              await page.waitForTimeout(1500).catch(() => {});
            }
            log(
              `interval: ${gqlRows} ${meter.fuelType} reads via gql (${chunks} chunk(s)) ${dateFrom}..${dateTo}`
            );
          }
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

  return { account: acct, bills, usage, costs: costRows, weather, intervals, pdfsDownloaded };
}
