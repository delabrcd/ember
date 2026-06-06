// Pure helpers for the NG-login lifecycle (issue #22): the connection-status
// state machine, the keep-vs-delete decision for a removed login, and the
// constant-time password match used by the delete-confirmation gate.
//
// Kept browser/DB-free so they're unit-testable in isolation — the live
// Playwright/Prisma plumbing (run.ts, auth.ts, the API routes) imports these.
// Nothing here imports `@/lib/db` or `@/lib/settings`, so the unit suite stays
// DB-free exactly as CI runs it.
import { timingSafeEqual } from 'node:crypto';

// The connection status stored on `NgLogin.status` (a free-form String? column —
// no schema change). Two values drive the lifecycle:
//   - 'verified'     — last login/scrape succeeded; the login is good to use.
//   - 'needs_reauth' — a scrape hit a hard auth failure (wrong/disabled password)
//                      or an MFA step the unattended path can't complete. The
//                      scheduler skips it until the operator re-authenticates.
// Any other value (including null/'unknown' from older rows) is treated as
// usable — we never *introduce* a skip for a status we don't recognize.
export type LoginStatus = 'verified' | 'needs_reauth';

export const VERIFIED: LoginStatus = 'verified';
export const NEEDS_REAUTH: LoginStatus = 'needs_reauth';

// A login is paused for SCHEDULED scrapes only when it's explicitly flagged
// needs_reauth. Unknown/null/verified all run (good-guest: we don't hammer a
// known-bad credential, but we also don't silently drop a login we can't read).
export function shouldSkipScheduled(status: string | null | undefined): boolean {
  return status === NEEDS_REAUTH;
}

// Status after a successful login/scrape for a login: always returns to verified
// (clearing a prior needs_reauth flag). Pure so run.ts and the reauth route share
// one definition of "back to healthy".
export function statusOnSuccess(): LoginStatus {
  return VERIFIED;
}

// Classify a login error thrown during a scrape. Only a *hard auth* failure —
// wrong/disabled password, or an MFA/OTP step the unattended path can't finish —
// flips the login to needs_reauth. Transient failures (network blips, portal
// layout hiccups, a missing field) are NOT auth problems: returning isAuthFailure
// false leaves the status untouched so a flaky run doesn't pause a good login.
//
// We match on the messages auth.ts actually throws (see `login()` /
// `ensureLoggedIn`): the MFA guard, and the "Login failed (still on the login
// host)" / credential messages. Matching is substring/keyword based and
// deliberately conservative.
export interface LoginErrorClass {
  isAuthFailure: boolean;
  // A short, non-sensitive reason to store alongside the status. Never contains
  // the password (the source messages never include it).
  reason: string;
}

export function classifyLoginError(message: string): LoginErrorClass {
  const m = (message || '').toLowerCase();
  // MFA/OTP the unattended scraper can't complete.
  if (
    /one[\s-]?time|passcode|mfa|otp|verification code|authenticator/.test(m)
  ) {
    return { isAuthFailure: true, reason: 'needs a one-time passcode (MFA) the scheduler cannot complete' };
  }
  // Bad/expired credentials: auth.ts ends up "still on the login host" or asks to
  // "check credentials".
  if (/still on the login host|check (the )?credentials|check the username|login failed/.test(m)) {
    return { isAuthFailure: true, reason: 'sign-in failed — check the username and password' };
  }
  return { isAuthFailure: false, reason: '' };
}

// The keep-vs-delete decision for removing a login. Pure so the route and a test
// agree on exactly what each choice does. `deleteData: true` removes the login's
// accounts (and, by FK cascade, their bills/usage/costs/weather) plus their bill
// PDFs on disk; `false` keeps the accounts and lets the FK SET NULL unlink them.
export interface DeletionPlan {
  deleteAccounts: boolean; // also delete this login's Account rows (cascades child data)
  deletePdfs: boolean; // also remove those accounts' bill PDFs from disk
  keepData: boolean; // true when the accounts/data survive (loginId → null)
}

export function planDeletion(deleteData: boolean): DeletionPlan {
  return deleteData
    ? { deleteAccounts: true, deletePdfs: true, keepData: false }
    : { deleteAccounts: false, deletePdfs: false, keepData: true };
}

// Constant-time-ish equality for the delete-confirmation password check. Given
// the DECRYPTED stored password and the operator-submitted one, return whether
// they match without leaking length/content via early-exit timing. Compares over
// equal-length buffers (timingSafeEqual requires equal lengths), folding the
// length check into the result so a length mismatch is still a plain `false`.
//
// Neither input is logged or returned anywhere; callers pass the decrypted value
// in just for this comparison and drop it immediately.
export function passwordMatches(stored: string, submitted: string): boolean {
  const a = Buffer.from(stored, 'utf8');
  const b = Buffer.from(submitted, 'utf8');
  // Compare against a fixed-length copy so the work (and timing) doesn't reveal
  // the stored length; XOR in the real length-equality at the end.
  const len = a.length;
  const bPadded = Buffer.alloc(len);
  b.copy(bPadded); // truncates or zero-pads b to len
  const equalBytes = timingSafeEqual(a, bPadded);
  return equalBytes && a.length === b.length;
}
