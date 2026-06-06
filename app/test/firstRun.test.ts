import { describe, expect, it } from 'vitest';
import { envCredsUsable, isFirstRun } from '../src/lib/ngrid/firstRun';

// Pure first-run detection — no DB. The route gathers counts/flags and passes them.

describe('isFirstRun', () => {
  const fresh = { accountCount: 0, loginCount: 0, envCredsUsable: false };

  it('is true only on a fresh install: no accounts, no logins, no env creds', () => {
    expect(isFirstRun(fresh)).toBe(true);
  });

  it('is false when any billing account exists', () => {
    expect(isFirstRun({ ...fresh, accountCount: 1 })).toBe(false);
  });

  it('is false when a stored login exists', () => {
    expect(isFirstRun({ ...fresh, loginCount: 1 })).toBe(false);
  });

  it('is false when usable env creds are present', () => {
    expect(isFirstRun({ ...fresh, envCredsUsable: true })).toBe(false);
  });
});

describe('envCredsUsable', () => {
  it('requires both a non-blank user and a password', () => {
    expect(envCredsUsable('a@b.com', 'pw')).toBe(true);
    expect(envCredsUsable('a@b.com', undefined)).toBe(false);
    expect(envCredsUsable('a@b.com', '')).toBe(false);
    expect(envCredsUsable(undefined, 'pw')).toBe(false);
    expect(envCredsUsable('   ', 'pw')).toBe(false);
  });
});
