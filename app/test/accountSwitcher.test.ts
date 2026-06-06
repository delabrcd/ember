import { describe, expect, it } from 'vitest';
import {
  shapeAccount,
  buildAccountGroups,
  hasMultipleAccounts,
  accountOptionLabel,
  resolveSelectedAccountId,
  type AccountSummary,
} from '../src/lib/accountSwitcher';

// A couple of accounts: one discovered through a stored login, one bootstrapped
// from env creds (no NgLogin row → loginId/login null).
const withLogin = {
  id: 1,
  accountNumber: '111',
  serviceAddress: '1 Main St',
  region: 'NY',
  loginId: 7,
  login: { id: 7, label: 'Home login' },
};
const envAcct = {
  id: 2,
  accountNumber: '222',
  serviceAddress: null,
  region: null,
  loginId: null,
  login: null,
};

describe('shapeAccount (hand-calculated)', () => {
  it('flattens the joined login to id + label and never leaks more', () => {
    expect(shapeAccount(withLogin)).toEqual({
      id: 1,
      accountNumber: '111',
      serviceAddress: '1 Main St',
      region: 'NY',
      loginId: 7,
      loginLabel: 'Home login',
    });
  });

  it('reports a null loginLabel for an env-bootstrapped account', () => {
    expect(shapeAccount(envAcct)).toEqual({
      id: 2,
      accountNumber: '222',
      serviceAddress: null,
      region: null,
      loginId: null,
      loginLabel: null,
    });
  });
});

const A = shapeAccount(withLogin); // loginId 7
const B = shapeAccount(envAcct); // loginId null
const C: AccountSummary = { id: 3, accountNumber: '333', serviceAddress: '3 Elm', region: 'NY', loginId: 7, loginLabel: 'Home login' };
const D: AccountSummary = { id: 4, accountNumber: '444', serviceAddress: '4 Oak', region: 'MA', loginId: 9, loginLabel: 'Work login' };

describe('buildAccountGroups (hand-calculated)', () => {
  it('is empty for no accounts', () => {
    expect(buildAccountGroups([])).toEqual([]);
  });

  it('returns one heading-less group when every account shares a login', () => {
    expect(buildAccountGroups([A, C])).toEqual([{ loginId: 7, label: null, accounts: [A, C] }]);
  });

  it('also collapses a single account to one heading-less group', () => {
    expect(buildAccountGroups([A])).toEqual([{ loginId: 7, label: null, accounts: [A] }]);
  });

  it('splits into per-login labelled groups when logins differ, preserving order', () => {
    expect(buildAccountGroups([A, D, C])).toEqual([
      { loginId: 7, label: 'Home login', accounts: [A, C] },
      { loginId: 9, label: 'Work login', accounts: [D] },
    ]);
  });

  it('labels the env-bootstrapped (login-less) group with the fallback', () => {
    const groups = buildAccountGroups([A, B], 'Env creds');
    expect(groups).toEqual([
      { loginId: 7, label: 'Home login', accounts: [A] },
      { loginId: null, label: 'Env creds', accounts: [B] },
    ]);
  });
});

describe('hasMultipleAccounts', () => {
  it('is true only with more than one account', () => {
    expect(hasMultipleAccounts([])).toBe(false);
    expect(hasMultipleAccounts([A])).toBe(false);
    expect(hasMultipleAccounts([A, B])).toBe(true);
  });
});

describe('accountOptionLabel', () => {
  it('joins number + service address, and omits the address when absent', () => {
    expect(accountOptionLabel(A)).toBe('111 · 1 Main St');
    expect(accountOptionLabel(B)).toBe('222');
  });
});

describe('resolveSelectedAccountId', () => {
  it('keeps a selection that still exists', () => {
    expect(resolveSelectedAccountId([A, B], 2)).toBe(2);
  });

  it('drops a stale selection (account no longer present)', () => {
    expect(resolveSelectedAccountId([A, B], 99)).toBeNull();
  });

  it('treats null/undefined as "default account"', () => {
    expect(resolveSelectedAccountId([A, B], null)).toBeNull();
    expect(resolveSelectedAccountId([A, B], undefined)).toBeNull();
  });
});
