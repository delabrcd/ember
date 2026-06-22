'use client';

// Self-fetch hook for the interval widgets (issue #150). IntervalLoadShape and
// IntervalHeatmap each hand-rolled the same fetch/loading/error scaffold: set
// loading, GET a /api/interval/* url, json(), VALIDATE the shape (else fall back to
// an empty payload so a malformed response shows the empty state, not a crash), and
// an `alive` flag so a stale response can't overwrite the current one. This
// consolidates that.
//
// IntervalHistory is DELIBERATELY NOT a caller — it has a richer SWR fetch
// (lib/intervalCache.ts: warm-cache hydrate, no-cold-blank revalidate, overscan).
// That's its own concern (issue #156). Only LoadShape + Heatmap use this.
//
// Each caller keeps its DISTINCT `validate`: it receives the parsed json and returns
// the typed payload (mapping anything malformed to that widget's empty payload).
// The hook never inspects the shape itself — that stays per-widget.
//
// `error: true` is the terminal fetch-failure sentinel (the network/parse threw);
// `undefined` is the loading state — same tri-state the originals used.
//
// Impure browser shell under lib/hooks (type-checked lib ESLint applies); the
// hermetic vitest suite never imports it.

import { useEffect, useRef, useState } from 'react';

export type IntervalLoadState<T> = T | { error: true } | undefined;

export function useIntervalPayload<T>(
  url: string,
  // Map a parsed response into the typed payload (callers fold their own empty
  // fallback in here). Pure per call; the hook only owns the fetch lifecycle.
  validate: (json: unknown) => T,
): {
  state: IntervalLoadState<T>;
  loading: boolean;
  errored: boolean;
  payload: T | null;
} {
  const [state, setState] = useState<IntervalLoadState<T>>(undefined);

  // `validate` is read through a ref so callers can pass an inline closure without
  // re-running the fetch on every render — the fetch identity is the `url` alone.
  const validateRef = useRef(validate);
  validateRef.current = validate;

  useEffect(() => {
    let alive = true;
    setState(undefined);
    // `void` the promise chain: it's fire-and-forget (state updates land via the
    // handlers, guarded by `alive`), so no-floating-promises is satisfied honestly
    // without an unhandled rejection — the .catch() handles failure.
    void fetch(url)
      .then((r) => r.json() as Promise<unknown>)
      .then((j) => {
        if (!alive) return;
        setState(validateRef.current(j));
      })
      .catch(() => {
        if (alive) setState({ error: true });
      });
    return () => {
      alive = false;
    };
  }, [url]);

  const loading = state === undefined;
  const errored = !!state && typeof state === 'object' && 'error' in state;
  const payload = !loading && !errored ? (state as T) : null;
  return { state, loading, errored, payload };
}
