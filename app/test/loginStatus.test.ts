import { describe, expect, it } from 'vitest';
import {
  NEEDS_REAUTH,
  VERIFIED,
  classifyLoginError,
  passwordMatches,
  planDeletion,
  shouldSkipScheduled,
  statusOnSuccess,
} from '../src/lib/ngrid/loginStatus';

describe('login status state machine (pure)', () => {
  it('only skips scheduled scrapes for an explicit needs_reauth flag', () => {
    expect(shouldSkipScheduled(NEEDS_REAUTH)).toBe(true);
    // Anything we don't recognize as needs_reauth still runs (never silently drop).
    expect(shouldSkipScheduled(VERIFIED)).toBe(false);
    expect(shouldSkipScheduled('unknown')).toBe(false);
    expect(shouldSkipScheduled(null)).toBe(false);
    expect(shouldSkipScheduled(undefined)).toBe(false);
    expect(shouldSkipScheduled('')).toBe(false);
  });

  it('returns to verified on a successful login/scrape', () => {
    expect(statusOnSuccess()).toBe('verified');
    expect(statusOnSuccess()).toBe(VERIFIED);
  });

  it('a freshly-needs_reauth login is the one the scheduler skips', () => {
    // The round trip the run loop relies on: a flagged login is skipped, then
    // after a successful re-auth/scrape it goes back to verified and runs again.
    const flagged = NEEDS_REAUTH;
    expect(shouldSkipScheduled(flagged)).toBe(true);
    const cleared = statusOnSuccess();
    expect(shouldSkipScheduled(cleared)).toBe(false);
  });
});

describe('classifyLoginError (pure)', () => {
  it('flags an MFA/OTP failure the unattended path cannot complete', () => {
    const msgs = [
      'This account requires a one-time passcode (MFA) at login, which the unattended scraper cannot complete.',
      'Login blocked by an MFA/OTP step.',
      'enter the verification code from your authenticator',
    ];
    for (const m of msgs) {
      const c = classifyLoginError(m);
      expect(c.isAuthFailure).toBe(true);
      expect(c.reason).toMatch(/passcode|MFA/i);
    }
  });

  it('flags a credential failure (still on the login host / check credentials)', () => {
    const msgs = [
      'Login failed (still on the login host). Check credentials. Page said: ...',
      'Login failed (still on the login host). Check the username and password.',
    ];
    for (const m of msgs) {
      expect(classifyLoginError(m).isAuthFailure).toBe(true);
    }
  });

  it('does NOT flag transient/non-auth errors (so a flaky run never pauses a good login)', () => {
    const msgs = [
      'Could not find the email field on the login page',
      'Could not determine the account number from the portal.',
      'net::ERR_CONNECTION_RESET',
      'navigation timeout of 60000 ms exceeded',
      '',
    ];
    for (const m of msgs) {
      const c = classifyLoginError(m);
      expect(c.isAuthFailure).toBe(false);
      expect(c.reason).toBe('');
    }
  });
});

describe('planDeletion (pure keep-vs-delete decision)', () => {
  it('keeps data by default (deleteData=false → SET NULL unlinks accounts)', () => {
    expect(planDeletion(false)).toEqual({ deleteAccounts: false, deletePdfs: false, keepData: true });
  });

  it('deletes accounts + PDFs when asked (deleteData=true)', () => {
    expect(planDeletion(true)).toEqual({ deleteAccounts: true, deletePdfs: true, keepData: false });
  });
});

describe('passwordMatches (constant-time-ish compare)', () => {
  it('returns true only for an exact match', () => {
    expect(passwordMatches('hunter2', 'hunter2')).toBe(true);
  });

  it('rejects a wrong password of equal length', () => {
    expect(passwordMatches('hunter2', 'hunteR2')).toBe(false);
    expect(passwordMatches('abcdefg', 'abcdefh')).toBe(false);
  });

  it('rejects on length mismatch (prefix is not a match)', () => {
    expect(passwordMatches('hunter2', 'hunter')).toBe(false);
    expect(passwordMatches('hunter', 'hunter2')).toBe(false);
    expect(passwordMatches('hunter2', '')).toBe(false);
    expect(passwordMatches('', 'x')).toBe(false);
  });

  it('matches the empty string against itself', () => {
    expect(passwordMatches('', '')).toBe(true);
  });

  it('handles unicode / multibyte passwords', () => {
    expect(passwordMatches('naïve-café-☕', 'naïve-café-☕')).toBe(true);
    expect(passwordMatches('naïve-café-☕', 'naive-cafe-X')).toBe(false);
  });
});
