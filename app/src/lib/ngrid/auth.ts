// Azure AD B2C login for myaccount.nationalgrid.com, with session reuse.
// Ported from the proven standalone scraper (ngrid-scrape/lib.js).
import fs from 'fs';
import path from 'path';
import type { BrowserContext, Page } from 'playwright';
import { prisma } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';

export interface Creds {
  user: string;
  pass: string;
}

const DATA_DIR = process.env.DATA_DIR || '/data';
const SESSION_DIR = path.join(DATA_DIR, 'session');
const STATE_FILE = path.join(SESSION_DIR, 'session.json');

export function dataDir(): string {
  return DATA_DIR;
}

// Where a login's saved session lives. The env/default scrape keeps the original
// `session.json` (so existing installs reuse their session unchanged); each
// stored NgLogin gets its OWN file so multi-login scrapes don't cross-reuse one
// account's cookies for another. A bad session must never bleed across logins.
function stateFileFor(loginId?: number): string {
  return loginId === undefined ? STATE_FILE : path.join(SESSION_DIR, `session-login-${loginId}.json`);
}

// Env credentials — the bootstrap/fallback source. Kept as-is so a fresh install
// with no stored login (and no NgLogin table rows yet) scrapes exactly as before.
export function getCreds(): Creds {
  const user = process.env.NGRID_USER;
  const pass = process.env.NGRID_PASS;
  if (!user || !pass) throw new Error('NGRID_USER / NGRID_PASS env vars are not set');
  return { user, pass };
}

// Decrypt a stored login row into plaintext creds. The password is only ever
// decrypted here, just-in-time for a login; it is never returned to the client.
function credsFromLogin(login: {
  username: string;
  ciphertext: string;
  iv: string;
  authTag: string;
}): Creds {
  const pass = decryptSecret({
    ciphertext: login.ciphertext,
    iv: login.iv,
    authTag: login.authTag,
  });
  return { user: login.username, pass };
}

// Resolve credentials for a SPECIFIC stored login. Throws if it doesn't exist.
export async function resolveCredsForLogin(loginId: number): Promise<Creds> {
  const login = await prisma.ngLogin.findUnique({ where: { id: loginId } });
  if (!login) throw new Error(`NgLogin ${loginId} not found`);
  return credsFromLogin(login);
}

// Store-first credential resolution. If any stored login exists, use the most
// recently verified one (falling back to the most recently created); otherwise
// fall back to env creds. This lets the encrypted store take precedence when
// present while keeping the env-only path working when it's empty.
export async function resolveCreds(): Promise<Creds> {
  const login = await prisma.ngLogin.findFirst({
    orderBy: [{ lastVerifiedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
  });
  if (login) return credsFromLogin(login);
  return getCreds();
}

export function contextOptions(loginId?: number): Record<string, unknown> {
  const opts: Record<string, unknown> = {
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  };
  const stateFile = stateFileFor(loginId);
  if (fs.existsSync(stateFile)) opts.storageState = stateFile;
  return opts;
}

export async function saveState(ctx: BrowserContext, loginId?: number): Promise<void> {
  // The session holds live auth cookies + bearer tokens — restrict it to the
  // owner (0700 dir, 0600 file) on top of living in a root-only Docker volume.
  const stateFile = stateFileFor(loginId);
  fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  fs.chmodSync(SESSION_DIR, 0o700);
  await ctx.storageState({ path: stateFile });
  fs.chmodSync(stateFile, 0o600);
}

async function firstVisible(page: Page, selectors: string[], timeout = 15000): Promise<string | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const el = await page.$(sel);
      if (el && (await el.isVisible().catch(() => false))) return sel;
    }
    await page.waitForTimeout(300);
  }
  return null;
}

// Detect an MFA/OTP step so we can fail with a clear message instead of hanging.
async function looksLikeMfa(page: Page): Promise<boolean> {
  const txt = (await page.evaluate(() => document.body.innerText).catch(() => '')) as string;
  return /one[\s-]?time|verification code|enter the code|passcode|authenticator/i.test(txt);
}

async function login(page: Page, user: string, pass: string, log: (m: string) => void): Promise<string> {
  log('opening myaccount.nationalgrid.com');
  await page.goto('https://myaccount.nationalgrid.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForURL(/login\.nationalgrid\.com|b2clogin\.com/, { timeout: 60000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  const emailSel = await firstVisible(page, ['#signInName', '#email', 'input[type="email"]', 'input[name="email"]']);
  if (!emailSel) throw new Error('Could not find the email field on the login page');
  await page.fill(emailSel, user);

  let passSel = await firstVisible(page, ['#password', 'input[type="password"]'], 3000);
  if (!passSel) {
    const nextSel = await firstVisible(page, ['#interceptButton', '#next', '#continue', 'button[type="submit"]'], 3000);
    if (nextSel) {
      await page.click(nextSel);
      await page.waitForTimeout(2000);
    }
    passSel = await firstVisible(page, ['#password', 'input[type="password"]'], 10000);
  }
  if (!passSel) throw new Error('Could not find the password field');
  await page.fill(passSel, pass);

  const submitSel = await firstVisible(page, ['#interceptButton', '#next', 'button.sign-in', 'input[type="submit"]'], 8000);
  const navP = page.waitForURL(/myaccount\.nationalgrid\.com/, { timeout: 60000 }).catch(() => {});
  if (submitSel) await page.click(submitSel);
  await page.waitForTimeout(2500);
  if (/login\.nationalgrid\.com|b2clogin\.com/.test(page.url())) {
    if (await looksLikeMfa(page)) {
      throw new Error(
        'This account requires a one-time passcode (MFA) at login, which the unattended scraper cannot complete. ' +
          'Disable MFA on the account or wait for interactive-login support.'
      );
    }
    await page
      .evaluate(() => {
        const b = document.querySelector('#continue') as HTMLButtonElement | null;
        if (b) {
          b.removeAttribute('disabled');
          b.click();
        }
      })
      .catch(() => {});
  }
  await navP;
  await page.waitForTimeout(2500);
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});

  const url = page.url();
  if (/login\.nationalgrid\.com|b2clogin\.com/.test(url)) {
    if (await looksLikeMfa(page)) throw new Error('Login blocked by an MFA/OTP step.');
    const bodyText = (await page.evaluate(() => document.body.innerText).catch(() => '')) as string;
    throw new Error('Login failed (still on the login host). Check credentials. Page said: ' + bodyText.slice(0, 300));
  }
  return url;
}

// Reuse a saved session if still valid; otherwise log in fresh and persist it.
// Returns the dashboard URL (carries the ?accountLink= param).
//
// `loginId` selects a SPECIFIC stored NgLogin (the per-login multi-account
// orchestration in run.ts passes it so the fresh-login path authenticates as
// that login). When omitted, fall back to store-first resolution (most-recently
// verified NgLogin, else env creds) — preserving the original behavior.
export async function ensureLoggedIn(
  page: Page,
  log: (m: string) => void = () => {},
  loginId?: number
): Promise<string> {
  const ctx = page.context();
  const { user, pass } = loginId !== undefined ? await resolveCredsForLogin(loginId) : await resolveCreds();
  const stateFile = stateFileFor(loginId);
  if (fs.existsSync(stateFile)) {
    log('trying saved session');
    await page
      .goto('https://myaccount.nationalgrid.com/dashboard', { waitUntil: 'domcontentloaded', timeout: 60000 })
      .catch(() => {});
    await page.waitForTimeout(2500);
    const url = page.url();
    if (/myaccount\.nationalgrid\.com\/(dashboard|$)/.test(url) && !/login\.nationalgrid\.com|b2clogin\.com/.test(url)) {
      log('session valid');
      return url;
    }
    log('session expired, logging in fresh');
  }
  const url = await login(page, user, pass, log);
  await saveState(ctx, loginId);
  log('session saved');
  return url;
}
