// First-run detection for the setup workflow (issue #30).
//
// A "first run" is a brand-new install with nothing to show and nothing to scrape
// with: no billing accounts, no stored NgLogin rows, and no usable env credential.
// Such installs get a guided setup state instead of the empty dashboard. The
// moment ANY of those exists (data OR a credential, stored or env) we're past
// first run and never show setup again — so existing installs are never disrupted.
//
// PURE + DB-free so it can be unit-tested without Prisma: the route gathers the
// counts/flags and passes them in.

export interface FirstRunInputs {
  // Number of billing Account rows.
  accountCount: number;
  // Number of stored NgLogin rows.
  loginCount: number;
  // Whether a usable env credential (NGRID_USER + NGRID_PASS) is present.
  envCredsUsable: boolean;
}

// True only when there's no data and nothing to scrape with.
export function isFirstRun(inputs: FirstRunInputs): boolean {
  return inputs.accountCount === 0 && inputs.loginCount === 0 && !inputs.envCredsUsable;
}

// Whether the env credential is usable: both NGRID_USER (non-blank) and
// NGRID_PASS are present. Matches the "usable env creds" notion elsewhere.
export function envCredsUsable(
  envUser: string | undefined,
  envPass: string | undefined
): boolean {
  return Boolean((envUser ?? '').trim() && envPass);
}
