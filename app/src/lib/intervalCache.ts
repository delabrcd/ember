// Tiny, dependency-free stale-while-revalidate (SWR) cache for the /api/interval
// "Usage history" widget (WS2 UX rework). It exists so a fuel-toggle, a range
// change, or a re-mount can REPAINT the last-seen series for that exact request
// INSTANTLY (from a module-level Map) while a fresh fetch revalidates in the
// background — that's what makes the widget feel snappy instead of cold-blanking
// to a skeleton on every control change.
//
// WHY ROLL OUR OWN (not swr/react-query): the dependency set here is deliberately
// small (see docs/standards.md §8). The cache we need is trivially small — a
// module-level Map keyed by the request and a single helper that returns the
// cached value (if any) and kicks off a revalidation. No React binding, no
// suspense, no GC policy beyond "last write wins per key" — the key space is tiny
// (one entry per fuel|from|to|account the user actually visits in a session).
//
// SSR-SAFE: this is a CLIENT util. The cache holds fetched API responses, so it
// must never run at import time on the server (Next renders components on the
// server first). We guard `fetch` usage behind a typeof check; the Map itself is
// inert (creating it server-side is harmless and just yields an empty,
// per-render cache that's never read because the widget is 'use client').
//
// PREFETCH-READY (deliberate API shape): a LATER workstream wants to PREFETCH the
// adjacent fuel / a likely range into THIS SAME cache so the eventual toggle is
// already warm. So the public surface is split into the primitive cache ops
// (`getCached` / `setCached`) AND the orchestrating `swrFetch` — a prefetcher can
// call `swrFetch(key, url)` ahead of time (fire-and-forget) to populate the cache,
// and the widget's later `swrFetch` for the same key returns the warm value
// immediately. `intervalCacheKey` centralizes the key format so the widget and any
// prefetcher agree byte-for-byte.

// The shape we cache: exactly the JSON the /api/interval route returns (WS1
// contract). We keep it as an opaque-ish record so this module stays decoupled
// from the widget's row/grain types — the widget narrows the fields it reads.
export type IntervalResponse = {
  rows: unknown[];
  grain?: number;
  fifteenMinFrom?: string | null;
  downsampled?: boolean;
};

// One cache entry. `value` is the last successful response for this key; nullable
// only transiently before the first success. `inFlight` dedupes concurrent
// revalidations for the same key (a re-render that re-calls swrFetch before the
// first resolves shares the same promise instead of firing a second request).
type Entry = {
  value: IntervalResponse | undefined;
  inFlight: Promise<IntervalResponse> | undefined;
};

// Module-level store. Survives re-renders and component unmount/remount within a
// page session (a full reload clears it, which is fine — the server cache header
// then serves the repeat quickly). Bounded in practice by how many distinct
// fuel|from|to|account tuples the user visits; we don't evict (the set is small
// and short-lived). Exported-via-functions only so callers can't mutate it raw.
const store = new Map<string, Entry>();

// Build the canonical cache key for a request. The widget and any prefetcher MUST
// use this so their keys match exactly (a mismatch = a cache miss = a needless
// cold fetch). Mirrors the /api/interval query params that vary the response:
// fuel, the resolved [from, to] window, the account, AND (WS8) the explicit
// `?bucket=` when the overscan client requests one. `grain` is still NOT part of the
// key — WS1 made the server choose the bucket when none is sent; but WS8's overscan
// fetches an explicit `?bucket=` (the view's grain over a wider window), so two
// requests for the SAME [from,to] at DIFFERENT buckets MUST be distinct cache
// entries — hence `bucket` joins the key. Omitted/null bucket keeps the legacy key
// shape (trailing empty segment) so pre-WS8 callers are unaffected.
export function intervalCacheKey(args: {
  fuel: string;
  from?: string | null;
  to?: string | null;
  accountId?: number | null;
  bucket?: number | null;
}): string {
  return `${args.fuel}|${args.from ?? ''}|${args.to ?? ''}|${args.accountId ?? ''}|${
    args.bucket ?? ''
  }`;
}

// Synchronous peek: the last successful response for this key, or undefined. The
// widget calls this on (re)render to paint immediately before/while revalidating.
export function getCached(key: string): IntervalResponse | undefined {
  return store.get(key)?.value;
}

// Write a response into the cache (used by swrFetch on success; exported so a
// prefetcher that fetched by some other path can seed the cache directly).
export function setCached(key: string, value: IntervalResponse): void {
  const entry = store.get(key);
  if (entry) {
    entry.value = value;
  } else {
    store.set(key, { value, inFlight: undefined });
  }
}

// The SWR primitive: kick off (or reuse) a network revalidation for `key`, fetch
// `url`, cache the result on success, and resolve with it. The caller typically
// pairs this with a prior `getCached(key)` for the instant repaint, then awaits
// this for the fresh swap.
//
// Concurrency: if a revalidation for this key is already in flight, we return that
// same promise (dedupe) rather than firing a second request — important when a
// fast re-render re-invokes swrFetch before the first resolves.
//
// SSR guard: `fetch` is only called in the browser. On the server (no window) we
// resolve to the cached value or an empty response so an accidental server call
// can't throw — the real fetch happens client-side after hydration.
export function swrFetch(key: string, url: string): Promise<IntervalResponse> {
  const existing = store.get(key);
  if (existing?.inFlight) return existing.inFlight;

  if (typeof window === 'undefined') {
    // Server: never touch the network here. Hand back whatever we have (usually
    // nothing) so the client can revalidate after hydration.
    return Promise.resolve(existing?.value ?? { rows: [] });
  }

  const promise = fetch(url)
    .then((r) => r.json())
    .then((j): IntervalResponse => {
      const value: IntervalResponse = {
        rows: Array.isArray(j?.rows) ? j.rows : [],
        grain: typeof j?.grain === 'number' ? j.grain : undefined,
        fifteenMinFrom: typeof j?.fifteenMinFrom === 'string' ? j.fifteenMinFrom : null,
        downsampled: j?.downsampled === true,
      };
      setCached(key, value);
      return value;
    })
    .finally(() => {
      // Clear the in-flight marker whether we succeeded or failed; a later call
      // is free to retry. On failure we leave any prior `value` intact (stale data
      // beats a blank — the widget keeps showing the last-good series).
      const e = store.get(key);
      if (e) e.inFlight = undefined;
    });

  // Record the in-flight promise so concurrent callers dedupe onto it.
  if (existing) {
    existing.inFlight = promise;
  } else {
    store.set(key, { value: undefined, inFlight: promise });
  }
  return promise;
}

// Test-only: drop all entries so a unit test starts from a clean cache. Not used
// by the app (the module-level store is the intended runtime singleton).
export function __clearIntervalCache(): void {
  store.clear();
}
