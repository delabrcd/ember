// Pure helpers for the account switcher (step 4 of the NG-login epic). No DB,
// browser, or React — the /api/accounts route and the Dashboard switcher feed
// these the raw rows, and test/accountSwitcher.test.ts exercises them.
//
// Two jobs:
//   1. shapeAccount — turn a DB Account (+ its joined NgLogin) into the flat,
//      client-safe row /api/accounts returns. NEVER leaks a credential; the
//      login is reduced to its id + label only.
//   2. buildAccountGroups — arrange those rows for the header control: one flat
//      list when there's a single login, and login-labelled groups when there
//      are several (so a user can tell which credential each account came from).

// What the route returns per account. loginLabel is null for accounts
// bootstrapped from env creds (NGRID_USER/NGRID_PASS), which have no NgLogin.
export interface AccountSummary {
  id: number;
  accountNumber: string;
  serviceAddress: string | null;
  region: string | null;
  loginId: number | null;
  loginLabel: string | null;
}

// The minimal slice of a DB row shapeAccount needs. Keeping it structural (not
// the Prisma type) keeps this file free of a DB import so it stays unit-testable.
export interface AccountRow {
  id: number;
  accountNumber: string;
  serviceAddress: string | null;
  region: string | null;
  loginId: number | null;
  login?: { id: number; label: string } | null;
}

export function shapeAccount(a: AccountRow): AccountSummary {
  return {
    id: a.id,
    accountNumber: a.accountNumber,
    serviceAddress: a.serviceAddress ?? null,
    region: a.region ?? null,
    loginId: a.loginId ?? null,
    loginLabel: a.login?.label ?? null,
  };
}

// A group of accounts under one login (or the env-bootstrapped, login-less set).
// `label` is null only for the env-bootstrapped group; it's also null on the
// single-group case where we don't show a heading at all.
export interface AccountGroup {
  loginId: number | null;
  label: string | null;
  accounts: AccountSummary[];
}

// Arrange accounts for the switcher. When every account shares one login (or
// there are none / one login distinct), we return a single, heading-less group
// so the UI renders a flat list. With multiple logins we split into one group
// per login, each labelled, preserving the input order within and across groups
// (first-seen login leads). Env-bootstrapped accounts (loginId null) form their
// own group, labelled by the caller-supplied `envLabel`.
export function buildAccountGroups(
  accounts: AccountSummary[],
  envLabel = 'Other accounts'
): AccountGroup[] {
  const loginIds = new Set(accounts.map((a) => a.loginId));
  // One login (or zero) → a single flat, heading-less group.
  if (loginIds.size <= 1) {
    return accounts.length ? [{ loginId: accounts[0].loginId, label: null, accounts }] : [];
  }

  const groups: AccountGroup[] = [];
  const byLogin = new Map<number | null, AccountGroup>();
  for (const a of accounts) {
    let g = byLogin.get(a.loginId);
    if (!g) {
      g = { loginId: a.loginId, label: a.loginLabel ?? envLabel, accounts: [] };
      byLogin.set(a.loginId, g);
      groups.push(g);
    }
    g.accounts.push(a);
  }
  return groups;
}

// True when the switcher should render as a control rather than a static label:
// only worth the chrome once there's more than one account to switch between.
export function hasMultipleAccounts(accounts: AccountSummary[]): boolean {
  return accounts.length > 1;
}

// The short, human label for one account in the control: account number, plus
// the service address when present.
export function accountOptionLabel(a: AccountSummary): string {
  return a.serviceAddress ? `${a.accountNumber} · ${a.serviceAddress}` : a.accountNumber;
}

// Resolve a persisted/selected id against the live account list: returns the id
// if it still exists, else null (caller falls back to the default account).
export function resolveSelectedAccountId(
  accounts: AccountSummary[],
  selected: number | null | undefined
): number | null {
  if (selected == null) return null;
  return accounts.some((a) => a.id === selected) ? selected : null;
}
