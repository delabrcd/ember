import { describe, expect, it } from 'vitest';
import { shouldBootstrapEnvLogin } from '../src/lib/ngrid/bootstrap';

// These tests cover only the PURE decision helper — no DB, no crypto, no env.
// The runner (bootstrapEnvLogin) is exercised live against a throwaway Postgres.

describe('shouldBootstrapEnvLogin (pure import decision)', () => {
  const base = {
    secretKeySet: true,
    envUser: 'caleb@example.com',
    envPass: 'hunter2',
    existingUsernames: [] as string[],
  };

  it('imports when key + env creds are present and no login exists yet', () => {
    expect(shouldBootstrapEnvLogin(base)).toBe(true);
  });

  it('does NOT import when NGRID_SECRET_KEY is unset', () => {
    expect(shouldBootstrapEnvLogin({ ...base, secretKeySet: false })).toBe(false);
  });

  it('does NOT import when the env user is missing/blank', () => {
    expect(shouldBootstrapEnvLogin({ ...base, envUser: undefined })).toBe(false);
    expect(shouldBootstrapEnvLogin({ ...base, envUser: '' })).toBe(false);
    expect(shouldBootstrapEnvLogin({ ...base, envUser: '   ' })).toBe(false);
  });

  it('does NOT import when the env password is missing/blank', () => {
    expect(shouldBootstrapEnvLogin({ ...base, envPass: undefined })).toBe(false);
    expect(shouldBootstrapEnvLogin({ ...base, envPass: '' })).toBe(false);
  });

  it('does NOT import when a login already exists for that username (exact match)', () => {
    expect(
      shouldBootstrapEnvLogin({ ...base, existingUsernames: ['caleb@example.com'] })
    ).toBe(false);
  });

  it('matches existing usernames case-insensitively and trim-insensitively', () => {
    expect(
      shouldBootstrapEnvLogin({ ...base, existingUsernames: ['  CALEB@Example.COM '] })
    ).toBe(false);
    // env username with surrounding whitespace / different case still matches.
    expect(
      shouldBootstrapEnvLogin({
        ...base,
        envUser: '  Caleb@Example.com  ',
        existingUsernames: ['caleb@example.com'],
      })
    ).toBe(false);
  });

  it('still imports when other (different) logins exist', () => {
    expect(
      shouldBootstrapEnvLogin({ ...base, existingUsernames: ['someone-else@example.com'] })
    ).toBe(true);
  });
});
