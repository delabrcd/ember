// One-off interval-data DISCOVERY (issue #76, phase 1). Deliberately MINIMAL and a
// good guest: reuse the saved session, open ONLY the /energy-usage page, click the
// interval tabs the operator described — "Real-time usage" (hourly, last 24h = the
// AMI interval payload) and "Energy usage" → "Day" (daily) — capture every gql
// request/response, write an artifact, and stop. No PDF downloads, no bill-history,
// no widening, no persist. Run inside the image:
//   INTERVAL_ACCOUNT_LINK=<link> npx tsx src/lib/ngrid/discoverInterval.ts
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { contextOptions, ensureLoggedIn, dataDir, saveState } from './auth';
import { buildNavUrl } from './accounts';
import { summarizeGqlRequest, summarizeGqlResponse } from './intervalDebug';

const BASE = 'https://myaccount.nationalgrid.com';
const log = (m: string) => console.log('[discover]', m);

// Click the first visible tab/button/link/option whose visible text matches `re`.
// Tries a range of tab-ish selectors; fully wrapped so a miss never throws.
async function clickByText(page: Page, re: RegExp, label: string): Promise<boolean> {
  for (const sel of ['[role="tab"]', 'button', 'a', 'li', '[role="option"]', '.tab', 'span', 'div']) {
    try {
      const loc = page.locator(sel).filter({ hasText: re });
      const n = await loc.count();
      for (let i = 0; i < n; i++) {
        const el = loc.nth(i);
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 3000 });
          log(`clicked ${label} via ${sel}`);
          return true;
        }
      }
    } catch {
      /* try next selector */
    }
  }
  log(`could not find ${label}`);
  return false;
}

async function main(): Promise<void> {
  const accountLink = process.env.INTERVAL_ACCOUNT_LINK || undefined;
  const browser = await chromium.launch();
  const ctx = await browser.newContext(contextOptions() as Record<string, never>);
  const page = await ctx.newPage();

  const debugLog: Array<{ kind: 'request' | 'response'; entry: unknown }> = [];
  // Broad capture of EVERY xhr/fetch data call (not just *-gql) so we can find the
  // real-time/interval endpoint, which clearly isn't a gql query. Records url +
  // method + status + content-type, plus a truncated body for JSON/XML payloads.
  const netLog: Array<Record<string, unknown>> = [];
  const seenNet = new Set<string>();

  await page.route('**/api/**-gql', async (route) => {
    try {
      const s = summarizeGqlRequest(route.request().url(), route.request().postData() || '');
      if (s) debugLog.push({ kind: 'request', entry: s });
    } catch {
      /* capture must never break the page */
    }
    await route.continue();
  });
  page.on('response', async (resp) => {
    const url = resp.url();
    const req = resp.request();
    const rtype = req.resourceType();
    // gql responses → the structured summarizer (unchanged).
    if (/\/api\/[a-z-]+-gql/.test(url)) {
      try {
        const json = await resp.json();
        const data = json?.data;
        if (data) {
          console.log('[discover] gql keys:', Object.keys(data).join('+'));
          debugLog.push({ kind: 'response', entry: summarizeGqlResponse(url, data) });
        }
      } catch {
        /* non-JSON / already consumed */
      }
      return;
    }
    // Everything else: only xhr/fetch DATA calls (skip documents, scripts, images,
    // fonts, css). Dedup by method+url. Capture a small body sample for json/xml.
    if (rtype !== 'xhr' && rtype !== 'fetch') return;
    const ct = (resp.headers()['content-type'] || '').toLowerCase();
    const key = `${req.method()} ${url.split('?')[0]}`;
    if (seenNet.has(key)) return;
    seenNet.add(key);
    let sample: string | undefined;
    if (/json|xml|text|csv/.test(ct)) {
      try {
        sample = (await resp.text()).slice(0, 600);
      } catch {
        /* body unavailable */
      }
    }
    const rec = { method: req.method(), url, status: resp.status(), contentType: ct, resourceType: rtype, sample };
    netLog.push(rec);
    console.log(`[discover] xhr ${rec.method} ${resp.status()} ${ct} ${url.slice(0, 140)}`);
  });

  await ensureLoggedIn(page, log);
  await page
    .goto(buildNavUrl(BASE, '/energy-usage', accountLink), { waitUntil: 'networkidle', timeout: 45000 })
    .catch(() => {});
  await page.waitForTimeout(4000);

  // 1) Real-time usage tab — hourly, last 24h (the AMI interval payload).
  await clickByText(page, /real[\s-]?time/i, 'Real-time usage tab');
  await page.waitForTimeout(5000);

  // 2) Energy usage tab, then the "Day" granularity (daily interval). The
  //    granularity may be a tab, a button, or a <select> option — try each.
  await clickByText(page, /energy\s*usage/i, 'Energy usage tab');
  await page.waitForTimeout(2500);
  // Granularity (Billing period / Day / Year). Try a native <select> first, then
  // a click on anything that reads "Day". Each attempt is independent + wrapped.
  try {
    const sel = page.locator('select');
    if (await sel.count()) {
      await sel.first().selectOption({ label: 'Day' }).catch(() => {});
      await page.waitForTimeout(3500);
    }
  } catch {
    /* no native select */
  }
  await clickByText(page, /\bday\b/i, 'Day granularity');
  await page.waitForTimeout(4000);

  // Artifact.
  try {
    const dir = process.env.BACKUP_DIR || path.join(dataDir(), 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const out = path.join(dir, `interval-discover-${ts}.json`);
    const requests = debugLog.filter((e) => e.kind === 'request').map((e) => e.entry);
    const responses = debugLog.filter((e) => e.kind === 'response').map((e) => e.entry);
    fs.writeFileSync(
      out,
      JSON.stringify({ capturedAt: new Date().toISOString(), accountLink, requests, responses, net: netLog }, null, 2)
    );
    const keys = [...new Set(responses.flatMap((r) => (r as { keys: string[] }).keys))].join(', ');
    console.log(`[discover] wrote ${out} (${requests.length} gql-req, ${responses.length} gql-resp, ${netLog.length} other xhr; gql keys: ${keys})`);
  } catch (e) {
    console.log('[discover] artifact write failed:', e);
  }

  await saveState(ctx).catch(() => {});
  await browser.close();
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('[discover] failed:', e);
    process.exit(1);
  });
