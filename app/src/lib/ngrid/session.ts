// PortalSession — a single reused National Grid login + browser context + page,
// plus the auth headers captured off the SPA's own GraphQL traffic. This is the
// shared "class" the Scheduler V2 task handlers (step 5) run against: acquire
// once per login per tick, run each portal task sequentially on the one page,
// then saveState() + close(). Mirrors the launch / login / header-capture
// sequence that collect() does inline today, so behavior is identical when the
// handlers eventually use it.
//
// Step 2 NOTE: this file is additive and NOT yet wired into collect() — collect
// keeps managing its own browser/ctx/page. This is dead-but-compiled code that
// the step-5 runner will call.
import { chromium } from 'playwright';
import type { BrowserContext, Page, Route } from 'playwright';
import { contextOptions, ensureLoggedIn, saveState as authSaveState } from './auth';
import { buildNavUrl } from './accounts';
import type { ProgressFn } from './types';

const BASE = 'https://myaccount.nationalgrid.com';

// Shared auth-header capture predicate. Pulls the SPA's bearer token +
// subscription key off a request's headers (exactly as collect.ts's onRoute
// does) and returns the header set we replay on the PDF + interval HTTP calls.
// Returns null until both required headers are present. Pure — no side effects.
export function captureAuthHeaders(
  reqHeaders: Record<string, string>,
  base: string
): { authorization: string; 'ocp-apim-subscription-key': string; origin: string } | null {
  if (reqHeaders.authorization && reqHeaders['ocp-apim-subscription-key']) {
    return {
      authorization: reqHeaders.authorization,
      'ocp-apim-subscription-key': reqHeaders['ocp-apim-subscription-key'],
      origin: base,
    };
  }
  return null;
}

export interface PortalSession {
  readonly loginId?: number;
  page: Page;
  ctx: BrowserContext;
  authHeaders: Record<string, string> | null;
  // Per-session scratchpad the handlers use for tick-local coordination — e.g.
  // full-scrape marks `fullScrapeDone` here so a multi-account login's several
  // due full-scrape tasks dedup to ONE collect() per session (the runner stays
  // task-agnostic; the handler self-dedups). Reset per acquire (starts {}).
  scratch: Record<string, unknown>;
  // Recapture the auth headers if we don't have them yet. Does at most ONE light
  // /dashboard navigation (good-guest) to make the SPA fire a gql request, reads
  // the captured headers off it, caches them, and returns. Throws if none could
  // be captured. A no-op returning the cache when already populated.
  ensureAuthHeaders(): Promise<Record<string, string>>;
  saveState(): Promise<void>;
  close(): Promise<void>;
}

// Launch a headless browser, restore/establish the login for `loginId`, and
// return a PortalSession. Mirrors collect()'s launch sequence (collect.ts:84-89)
// exactly: chromium.launch({ headless, --no-sandbox }) → newContext(contextOptions)
// → newPage() → ensureLoggedIn(). authHeaders starts null; capture is deferred to
// ensureAuthHeaders() so a session that only needs the page (e.g. a future task
// that doesn't hit the gql gateway) never pays for an extra nav.
export async function acquirePortalSession(
  loginId: number | undefined,
  log: ProgressFn
): Promise<PortalSession> {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const ctx = await browser.newContext(contextOptions(loginId));
  const page = await ctx.newPage();
  await ensureLoggedIn(page, log, loginId);
  // The link the portal landed on after login is our default/first account —
  // used as the ?accountLink= on the recapture nav so the SPA loads a real
  // account and fires its gql requests.
  const defaultLink = new URL(page.url()).searchParams.get('accountLink') || undefined;

  const session: PortalSession = {
    loginId,
    page,
    ctx,
    authHeaders: null,
    scratch: {},
    async ensureAuthHeaders(): Promise<Record<string, string>> {
      if (this.authHeaders) return this.authHeaders;
      let captured: Record<string, string> | null = null;
      const onRoute = async (route: Route) => {
        const req = route.request();
        if (!captured) {
          const h = captureAuthHeaders(req.headers(), BASE);
          if (h) captured = h;
        }
        await route.continue();
      };
      await page.route('**/api/**-gql', onRoute);
      try {
        // One light nav + the same 4s settle collect.ts:113-114 uses to let the
        // SPA fire its gql requests (and thus expose the auth headers).
        await page
          .goto(buildNavUrl(BASE, '/dashboard', defaultLink), { waitUntil: 'networkidle', timeout: 30000 })
          .catch(() => {});
        await page.waitForTimeout(4000);
      } finally {
        await page.unroute('**/api/**-gql', onRoute);
      }
      if (!captured) throw new Error('Could not capture auth headers from the portal.');
      this.authHeaders = captured;
      return captured;
    },
    async saveState(): Promise<void> {
      await authSaveState(ctx, loginId);
    },
    async close(): Promise<void> {
      await browser.close();
    },
  };
  return session;
}
