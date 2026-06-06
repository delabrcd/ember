// Pure helpers for the multi-account scrape (step 2 of the NG-login epic).
//
// A single National Grid login can expose several billing accounts. The SPA
// addresses each one with an opaque `accountLink` slug in the dashboard URL
// (`/dashboard?accountLink=<slug>`). We discover the full set from the account
// list the portal returns (the `OpowerAccount` / `billingaccount-cu-uwp-gql`
// op, or the `user` payload that backs the dashboard's account switcher), then
// scrape each link through the same dashboard → bill-history → energy-usage
// flow.
//
// These functions are pure (no browser / DB) so they can be unit-tested:
// extracting + de-duping the link list out of whatever shape NG hands back,
// and building the per-account navigation URLs.

// The portal nests the account list under a few different keys depending on the
// op. Be liberal in what we accept; we only need the `accountLink` slug.
const LINK_KEYS = ['accountLink', 'accountlink', 'link'] as const;

function pickLink(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  for (const k of LINK_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

// Flatten the candidate account arrays out of a captured GraphQL `data` blob.
// NG has surfaced the linked-account list under several shapes over time, so we
// look at the union of the spots it has used rather than hardcoding one path.
function accountNodes(data: unknown): unknown[] {
  if (!data || typeof data !== 'object') return [];
  const d = data as Record<string, any>;
  const candidates: unknown[] = [
    d.accounts,
    d.OpowerAccount,
    d.opowerAccount,
    d.billingAccounts,
    d.user?.accounts,
    d.user?.billingAccounts,
    d.user?.OpowerAccount,
  ];
  const out: unknown[] = [];
  for (const c of candidates) {
    if (!c) continue;
    const arr = Array.isArray((c as any)?.nodes)
      ? (c as any).nodes
      : Array.isArray(c)
        ? c
        : [c]; // a single account object (the dashboard's current account)
    for (const n of arr) if (n) out.push(n);
  }
  return out;
}

// Extract the de-duplicated, order-preserving list of `accountLink` slugs from
// one or more captured GraphQL `data` payloads. `defaultLink` (the slug already
// on the dashboard URL after login) is always included and kept FIRST so the
// scrape starts with the account the portal landed on — preserving the existing
// single-account behavior when nothing else is discovered.
export function extractAccountLinks(
  payloads: unknown[],
  defaultLink?: string
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (link: string | undefined) => {
    if (!link) return;
    if (seen.has(link)) return;
    seen.add(link);
    out.push(link);
  };

  add(defaultLink);
  for (const data of payloads) {
    for (const node of accountNodes(data)) add(pickLink(node));
  }
  return out;
}

// Build the dashboard navigation URL for a given page + optional accountLink.
// Mirrors the inline `?accountLink=` the scraper already used, factored out so
// it's testable and consistent across the discovery + per-account passes.
export function buildNavUrl(
  base: string,
  routePath: string,
  accountLink?: string
): string {
  const q = accountLink ? `?accountLink=${encodeURIComponent(accountLink)}` : '';
  return `${base}${routePath}${q}`;
}
