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

  // Widen filters + capture auth headers / identifiers from the app's requests.
  const onRoute = async (route: Route) => {
    const req = route.request();
    const h = req.headers();
    let post = req.postData() || '';
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
    if (process.env.SCRAPE_DEBUG) console.log('[collect] gql keys:', Object.keys(data).join('+'));
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

  return { account: acct, bills, usage, costs: costRows, weather, pdfsDownloaded };
}
