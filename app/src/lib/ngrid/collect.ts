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
import type { BrowserContext, Page, Route } from 'playwright';
import { contextOptions, ensureLoggedIn, dataDir, saveState } from './auth';
import { extractAccountLinks, buildNavUrl } from './accounts';
import { summarizeGqlRequest, summarizeGqlResponse } from './intervalDebug';
import { captureAuthHeaders } from './session';
import type { PortalSession } from './session';
import { downloadBillPdfs, fetchAmiIntervals } from './portalFetch';
import { type IntervalReadRow } from './interval';
import { yyyymm } from './dates';
import {
  GQL_URL_RE,
  type RawBillNode,
  type RawBillEnergyUsage,
  type RawBillingAccount,
  type RawEnergyUsageNode,
  type RawFuelType,
  type RawGqlData,
  type RawGqlResponse,
  type RawWeatherNode,
} from './collectRaw';
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
  // Injected probe so collect.ts stays DB-free (it must NOT import prisma):
  // returns whether the account already has stored interval rows. Used to decide
  // a one-time wide first-run hourly backfill. Omitted → treated as "has data"
  // (normal tail window), preserving the env-only behavior exactly.
  hasIntervalData?: (accountNumber: string) => Promise<boolean>;
  // Scheduler V2: when provided, collect() reuses this already-logged-in session's
  // browser context + page instead of launching/closing its own, and skips its own
  // ensureLoggedIn (the session guarantees login). The runner owns the session
  // lifecycle (acquire/saveState/close). When omitted, collect() behaves EXACTLY as
  // before — launches its own browser, logs in, and closes it. (Good-guest: a shared
  // session means ≤1 login per tick across all portal tasks.)
  session?: PortalSession;
}

const BASE = 'https://myaccount.nationalgrid.com';

// Unwrap a gql connection (`{ nodes: [...] }`) or a bare array into a plain array.
// Anything else → []. The element type is unknown (the caller narrows per shape).
// `yyyymm` is the shared pure helper from `./dates`.
const asArray = (x: unknown): unknown[] => {
  const nodes = (x as { nodes?: unknown } | null | undefined)?.nodes;
  return Array.isArray(nodes) ? nodes : Array.isArray(x) ? x : [];
};
const ymd = (d?: string): string | undefined => (d ? d.slice(0, 10) : undefined);
const unitFor = (usageType: string): string =>
  /KWH/i.test(usageType) ? 'kWh' : /THERM/i.test(usageType) ? 'therms' : '';

export async function collect(
  log: ProgressFn = () => {},
  opts: CollectOptions = {}
): Promise<CollectResult[]> {
  // With a session: reuse the runner's already-logged-in browser context + page
  // (no launch, no login, no close here — the runner owns that lifecycle).
  // Without one: the EXISTING behavior — launch our own browser, log in, close it.
  const ownBrowser = opts.session
    ? null
    : await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  // Create the context/page INSIDE the try so a throw here still reaches the
  // finally that closes ownBrowser — otherwise a launched-but-unused browser
  // leaks (same bug class as acquirePortalSession's guard).
  let ctx: BrowserContext;
  let page: Page;

  try {
    ctx = opts.session ? opts.session.ctx : await ownBrowser!.newContext(contextOptions(opts.loginId));
    page = opts.session ? opts.session.page : await ctx.newPage();
    if (!opts.session) await ensureLoggedIn(page, log, opts.loginId);
    // The link the portal landed on after login is our default/first account and
    // the fallback if discovery turns up nothing.
    const defaultLink = new URL(page.url()).searchParams.get('accountLink') || undefined;

    // ---- discover all accountLinks for this login --------------------------
    // The dashboard's account list (the OpowerAccount / billingaccount-cu-uwp-gql
    // op, or the `user` payload behind the account switcher) carries every linked
    // billing account. Capture those payloads on a dashboard visit, then parse
    // out the link slugs. If introspection/enumeration ever stops working we
    // still have `defaultLink`, so the scrape degrades to single-account.
    const discoveryPayloads: unknown[] = [];
    const onDiscovery = async (resp: import('playwright').Response) => {
      const url = resp.url();
      if (!GQL_URL_RE.test(url)) return;
      try {
        const json = (await resp.json()) as RawGqlResponse;
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
      const result = await collectOneAccount(page, ctx, link, log, opts.loginId, opts.hasIntervalData);
      result.loginId = opts.loginId;
      results.push(result);
    }
    return results;
  } finally {
    // Only close the browser we launched ourselves; a session-provided browser
    // is closed by the runner (which owns its lifecycle).
    await ownBrowser?.close();
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
  loginId: number | undefined,
  hasIntervalData?: (accountNumber: string) => Promise<boolean>
): Promise<CollectResult> {
  // Capture buckets (per-account). One field per gql data key collect() reads;
  // arrays hold the unwrapped `nodes` (narrowed per-row by the mappers below),
  // `account` holds the raw `billingAccount` payload, `user` is unused downstream.
  interface Cap {
    bills?: unknown[];
    usages?: unknown[];
    costs?: unknown[];
    billAmounts?: unknown[];
    weather?: unknown[];
    account?: RawBillingAccount;
    user?: unknown;
  }
  const cap: Cap = {};
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
      // The SPA's gql request body: `{ variables: {...}, query, ... }`. We read a
      // few identifiers off `variables` and widen its paging filters in place — the
      // values stay whatever the SPA sent (cast to string only where we record an
      // identifier we know is a string), so the widening is byte-identical to before.
      const j = JSON.parse(post) as { variables?: Record<string, unknown> };
      const v: Record<string, unknown> = j.variables || {};
      if (v.accountNumber) accountNumber = v.accountNumber as string;
      if (v.companyCode) companyCode = v.companyCode as string;
      if (v.region) weatherRegion = v.region as string;
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
    if (!haveAuth) {
      const captured = captureAuthHeaders(h, BASE);
      if (captured) {
        authHeaders.authorization = captured.authorization;
        authHeaders['ocp-apim-subscription-key'] = captured['ocp-apim-subscription-key'];
        authHeaders.origin = captured.origin;
        haveAuth = true;
      }
    }
    await route.continue({ postData: post });
  };

  // Capture responses by their data keys.
  const onResponse = async (resp: import('playwright').Response) => {
    const url = resp.url();
    if (!GQL_URL_RE.test(url)) return;
    let json: RawGqlResponse;
    try {
      json = (await resp.json()) as RawGqlResponse;
    } catch {
      return;
    }
    const data: RawGqlData | null | undefined = json?.data;
    if (!data) return;
    if (process.env.SCRAPE_DEBUG) {
      const dataRec = data as Record<string, unknown>;
      console.log('[collect] gql keys:', Object.keys(dataRec).join('+'));
      // Record EVERY gql response (not just the known cap.* keys) so the spike
      // can surface the MySmartEnergy interval payload alongside the rest.
      try {
        debugLog.push({ kind: 'response', entry: summarizeGqlResponse(url, dataRec) });
      } catch {
        /* debug capture must never affect the scrape */
      }
    }
    if (data.Bills) cap.bills = asArray(data.Bills);
    if (data.energyUsages) cap.usages = asArray(data.energyUsages);
    if (data.energyUsageCosts) cap.costs = asArray(data.energyUsageCosts);
    if (data.energyUsageBillAmounts) cap.billAmounts = asArray(data.energyUsageBillAmounts);
    if (data.weather) cap.weather = asArray(data.weather);
    if (data.billingAccount) cap.account = data.billingAccount as RawBillingAccount;
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
  // The serviceAddress may arrive as a plain string, a `{ serviceAddressCompressed
  // | compressed }` object, or something else (→ JSON.stringify fallback). Narrow
  // the `unknown` shape exactly as before.
  const rawAddr = cap.account?.serviceAddress;
  const addrObj = rawAddr as { serviceAddressCompressed?: string; compressed?: string } | null | undefined;
  const serviceAddress =
    typeof rawAddr === 'string'
      ? rawAddr
      : addrObj?.serviceAddressCompressed ||
        addrObj?.compressed ||
        (rawAddr ? JSON.stringify(rawAddr) : undefined);
  const fuelTypes = (Array.isArray(cap.account?.fuelTypes) ? (cap.account!.fuelTypes as RawFuelType[]) : [])
    .map((f) => (typeof f === 'string' ? f : f?.type))
    .filter(Boolean) as string[];

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

  const bills: BillRow[] = (cap.bills || []).map((raw) => {
    const b = raw as RawBillNode;
    return {
      statementDate: ymd(b.statementDate)!,
      periodFrom: ymd(b.billDuration?.fromDate),
      periodTo: ymd(b.billDuration?.toDate),
      totalDueAmount: typeof b.totalDueAmount === 'number' ? b.totalDueAmount : undefined,
      status: b.status,
      usageTypes: asArray(b.energyUsages)
        .map((n) => (n as RawBillEnergyUsage).usageType)
        .filter(Boolean) as string[],
    };
  });

  const usage: UsageRow[] = (cap.usages || []).map((raw) => {
    const u = raw as RawEnergyUsageNode;
    return {
      usageType: u.usageType as string,
      periodYearMonth: typeof u.usageYearMonth === 'number' ? u.usageYearMonth : yyyymm(u.dateFrom),
      dateFrom: ymd(u.dateFrom),
      dateTo: ymd(u.dateTo),
      quantity: Number(u.usage) || 0,
      unit: unitFor(u.usageType as string),
    };
  });

  // Per-fuel supply/delivery costs come from the bill PDFs (full history) — the
  // API's energyUsageCosts/energyUsageBillAmounts only cover ~24 months. Built
  // in the PDF loop below.
  const costRows: CostRow[] = [];

  // Weather has one row per fuelType per month; collapse to one temp per month.
  const weatherByMonth = new Map<string, WeatherRow>();
  for (const raw of cap.weather || []) {
    const w = raw as RawWeatherNode;
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
  if (haveAuth) {
    const pdf = await downloadBillPdfs(ctx, page, { accountNumber, authHeaders, bills, log });
    costRows.push(...pdf.costRows);
    pdfsDownloaded = pdf.pdfsDownloaded;
  } else {
    log('warning: no auth headers captured; skipping PDF download');
  }

  // ---- smart-meter AMI interval reads (issue #76 / #121) ------------------
  // Capture interval usage at BOTH grains (hourly gql backstop + best-effort
  // 15-min REST overlay), reusing the captured auth headers. PURELY observational:
  // these rows NEVER feed billed-cost numbers (AGENTS.md rule #1). The full logic
  // (good-guest sequencing, settle delays, first-run backfill) lives in
  // portalFetch.fetchAmiIntervals — a behavior-identical extraction of the block
  // that used to be inline here.
  const intervals: IntervalReadRow[] = await fetchAmiIntervals(ctx, page, {
    acct,
    rawAccount: cap.account,
    authHeaders,
    haveAuth,
    accountNumber,
    hasIntervalData,
    log,
  });

  return { account: acct, bills, usage, costs: costRows, weather, intervals, pdfsDownloaded };
}
