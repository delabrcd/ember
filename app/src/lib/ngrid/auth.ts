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

// Where a billing account's downloaded bill PDFs live (one dir per account
// number — see collect.ts, which writes `${dataDir()}/pdfs/<accountNumber>`).
// Exported so the login-delete flow can remove exactly those dirs and nothing
// else when the operator chooses to delete local data.
export function pdfDirForAccount(accountNumber: string): string {
  return path.join(DATA_DIR, 'pdfs', accountNumber);
}

// Delete the bill-PDF directories for the given account numbers. Scoped strictly
// to each account's own `pdfs/<accountNumber>` folder (never the pdfs root or a
// sibling account's dir). Best-effort per directory; returns how many were
// removed. A blank/odd account number is skipped so we never resolve outside the
// pdfs root.
export function deletePdfsForAccounts(accountNumbers: string[]): number {
  const root = path.join(DATA_DIR, 'pdfs');
  let removed = 0;
  for (const accountNumber of accountNumbers) {
    if (!accountNumber) continue;
    const dir = pdfDirForAccount(accountNumber);
    // Defense-in-depth: only ever delete a direct child of the pdfs root.
    if (path.dirname(dir) !== root || path.basename(dir) !== accountNumber) continue;
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* leave it; a stray PDF dir is non-fatal */
    }
  }
  return removed;
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

// Remove a login's saved session file. Called when a stored login is deleted so
// its auth cookies don't linger on disk. Best-effort: a missing file is fine.
export function deleteSession(loginId: number): void {
  const stateFile = stateFileFor(loginId);
  try {
    fs.rmSync(stateFile, { force: true });
  } catch {
    /* already gone / not writable — non-fatal */
  }
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
// Exported for the interactive pre-flight login (step 3), which PAUSES here for
// an operator-supplied code instead of throwing.
export async function looksLikeMfa(page: Page): Promise<boolean> {
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

// ---- interactive (operator-attended) login ------------------------------
// Step 3: the in-app NG-login pre-flight. Unlike the unattended `login()` above
// (which THROWS at MFA so scheduled scrapes fail cleanly), this variant PAUSES
// at the OTP step and asks the caller for a one-time code, then resumes the same
// live page. It deliberately reuses the same selectors as `login()` so the two
// paths stay in lockstep when the portal changes. Used only by the pre-flight
// registry (preflight.ts); the scheduled path is untouched.

const OTP_INPUT_SELECTORS = [
  '#otpCode',
  '#oneTimeCode',
  '#verificationCode',
  'input[name="otpCode"]',
  'input[autocomplete="one-time-code"]',
  'input[name="code"]',
  'input[type="tel"]',
];
const OTP_SUBMIT_SELECTORS = ['#interceptButton', '#continue', '#verifyCode', 'button[type="submit"]', 'input[type="submit"]'];

export interface InteractiveLoginHooks {
  // Called when the portal presents the OTP step. Resolves with the operator's
  // one-time code (already validated/normalized by the caller). The code is used
  // once and never stored or logged.
  onOtpNeeded: () => Promise<string>;
}

// Fill email + password and submit, exactly as `login()` does. Shared so the
// interactive path can't drift from the unattended one. Returns once the submit
// click has fired and the page has had a moment to settle.
async function fillCredentials(page: Page, user: string, pass: string, log: (m: string) => void): Promise<void> {
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
  if (submitSel) await page.click(submitSel);
  await page.waitForTimeout(2500);
}

const onLoginHost = (url: string): boolean => /login\.nationalgrid\.com|b2clogin\.com/.test(url);
const onMyAccount = (url: string): boolean => /myaccount\.nationalgrid\.com/.test(url) && !onLoginHost(url);

// Run an operator-attended login that can pause at OTP. On the MFA step it calls
// `onOtpNeeded()`, fills the returned code, submits, and confirms we landed on
// myaccount. Throws on bad credentials or a login that never completes. Returns
// the dashboard URL. The caller persists the session (it needs the new login id
// to scope the state file), so this function doesn't save state itself.
export async function loginInteractive(
  page: Page,
  creds: Creds,
  hooks: InteractiveLoginHooks,
  log: (m: string) => void = () => {}
): Promise<string> {
  await fillCredentials(page, creds.user, creds.pass, log);

  // If we're still on the login host, it's either an MFA step or a credential
  // failure. Distinguish the two: MFA → pause for a code; otherwise → fail.
  if (onLoginHost(page.url())) {
    if (await looksLikeMfa(page)) {
      log('one-time passcode required; waiting for the operator');
      const code = await hooks.onOtpNeeded(); // one-shot; never stored/logged
      const otpSel = await firstVisible(page, OTP_INPUT_SELECTORS, 8000);
      if (!otpSel) throw new Error('Could not find the one-time-code field on the MFA page.');
      await page.fill(otpSel, code);
      const submitSel = await firstVisible(page, OTP_SUBMIT_SELECTORS, 8000);
      const navP = page.waitForURL(/myaccount\.nationalgrid\.com/, { timeout: 60000 }).catch(() => {});
      if (submitSel) await page.click(submitSel);
      await navP;
      await page.waitForTimeout(2500);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    } else {
      // Some B2C variants gate a final #continue button before redirecting.
      await page
        .evaluate(() => {
          const b = document.querySelector('#continue') as HTMLButtonElement | null;
          if (b) {
            b.removeAttribute('disabled');
            b.click();
          }
        })
        .catch(() => {});
      await page.waitForURL(/myaccount\.nationalgrid\.com/, { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(2500);
      await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    }
  }

  const url = page.url();
  if (!onMyAccount(url)) {
    if (await looksLikeMfa(page)) {
      throw new Error('The one-time passcode was not accepted. Double-check the code and try adding the login again.');
    }
    const bodyText = (await page.evaluate(() => document.body.innerText).catch(() => '')) as string;
    throw new Error('Login failed (still on the login host). Check the username and password. Page said: ' + bodyText.slice(0, 200));
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
