// SCRAPE_DEBUG-only discovery helpers (issue #76, phase 1: interval acquisition
// spike). PURE — no Playwright / fs / DB imports — so the unit suite stays
// hermetic and these can be exercised without a browser. The instrumentation in
// collect.ts uses them to summarize the portal's GraphQL traffic (requests +
// responses), including the MySmartEnergy interval query, into a small debug
// artifact we can reverse-engineer later. None of this runs unless SCRAPE_DEBUG
// is set; these functions only OBSERVE — they never mutate scrape state.

// Deep-clone-ish copy that keeps a debug sample small and bounded: arrays are
// capped to the first `maxArray` items (the tail replaced by a "…N more" marker
// string), and long strings are truncated to `maxStr` chars. Handles nested
// objects/arrays. PURE, no I/O.
export function truncateForDebug(value: unknown, maxArray = 3, maxStr = 400): unknown {
  if (typeof value === 'string') {
    return value.length > maxStr ? `${value.slice(0, maxStr)}…(${value.length} chars)` : value;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, maxArray).map((v) => truncateForDebug(v, maxArray, maxStr));
    const extra = value.length - maxArray;
    if (extra > 0) head.push(`…${extra} more`);
    return head;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateForDebug(v, maxArray, maxStr);
    }
    return out;
  }
  return value;
}

// Summarize a GraphQL response's top-level `data` keys + a truncated sample of
// the payload, so we can see what each endpoint returns without dumping megabytes.
export function summarizeGqlResponse(
  url: string,
  data: Record<string, unknown>
): { url: string; keys: string[]; sample: unknown } {
  return {
    url,
    keys: Object.keys(data),
    sample: truncateForDebug(data),
  };
}

// Summarize a GraphQL request body: its operationName + (truncated) variables.
// Returns null if the body doesn't JSON-parse or isn't a GraphQL op (no query /
// operationName / variables), so non-GraphQL traffic is silently skipped.
export function summarizeGqlRequest(
  url: string,
  body: string
): { url: string; operationName?: string; variables?: unknown } | null {
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const obj = j as Record<string, unknown>;
  const looksLikeGql =
    'query' in obj || 'operationName' in obj || 'variables' in obj;
  if (!looksLikeGql) return null;
  const out: { url: string; operationName?: string; variables?: unknown } = { url };
  if (typeof obj.operationName === 'string') out.operationName = obj.operationName;
  if ('variables' in obj) out.variables = truncateForDebug(obj.variables);
  return out;
}
