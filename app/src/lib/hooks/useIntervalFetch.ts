'use client';

// The IntervalHistory SWR fetch lifecycle (issue #156 extract). This is the
// impure shell that owns ONLY the fetch side of the "Usage history" widget; the
// pure window math stays in lib/intervalZoom.ts and lib/intervalOverscan.ts.
//
// It is DISTINCT from useIntervalPayload (the LoadShape/Heatmap fetch hook):
// IntervalHistory needs the richer STALE-WHILE-REVALIDATE behaviour backed by the
// module-level cache (lib/intervalCache.ts):
//   • WARM-CACHE HYDRATE — paint the last-seen series for THIS key instantly (if
//     warm) so a fuel-toggle / range-change feels instant.
//   • NEVER COLD-BLANK — once there's ANY data on screen, a reload KEEPS the prior
//     chart up and overlays a shimmer (`revalidating`) instead of blanking to the
//     skeleton. Only the genuine first load (no cache, no prior data) shows the
//     skeleton (state === undefined).
//   • ALIVE-GUARD — an out-of-order response can't overwrite a newer one.
//   • STALE-BEATS-BLANK ON ERROR — a hard failure keeps any data we were showing;
//     the error card only appears when there's nothing at all.
//
// This is a behaviour-preserving extract of the inline effect that lived in
// IntervalHistory (WS2 SWR + WS8 overscan-keyed fetch). The widget passes the
// already-built `key` + `url` (which encode the fuel/window/bucket/account), and
// the hook returns the typed LoadState the render tree narrows.
//
// Impure browser shell under lib/hooks (the type-checked lib ESLint applies, incl.
// no-floating-promises); the hermetic vitest suite never imports it.

import { useEffect, useState } from 'react';
import {
  getCached,
  swrFetch,
  type IntervalResponse,
} from '@/lib/intervalCache';
import { type IntervalProfileRow } from '@/lib/intervalProfile';

// The /api/interval payload rows (fuelType + unit from the API, plus the
// IntervalProfileRow fields toHistoryPoints needs).
export type IntervalApiRow = IntervalProfileRow & { fuelType?: string; unit?: string };

// What the widget keeps in component state once it has a response. We normalize the
// SWR-cache payload (IntervalResponse, whose `rows` are `unknown[]`) into the typed
// rows + the WS1 metadata the UI reads. `error: true` is a distinct terminal state.
export type Loaded = {
  rows: IntervalApiRow[];
  grain: number | undefined; // chosen bucket width in seconds (WS1); undefined if absent
  fifteenMinFrom: string | null; // earliest 15-min timestamp, or null
  downsampled: boolean; // finer detail exists than what's shown
};
export type LoadState = Loaded | { error: true } | undefined;

// Narrow a cached/fetched IntervalResponse into the typed Loaded the UI reads.
// Centralized so the cache-hydrate path and the revalidate path agree.
export function toLoaded(resp: IntervalResponse): Loaded {
  return {
    rows: Array.isArray(resp.rows) ? (resp.rows as IntervalApiRow[]) : [],
    grain: typeof resp.grain === 'number' ? resp.grain : undefined,
    fifteenMinFrom: resp.fifteenMinFrom ?? null,
    // Absent flag → treat as native resolution (badge shown). Matches WS1's intent:
    // a missing `downsampled` means nothing was reported reduced.
    downsampled: resp.downsampled === true,
  };
}

// Fetch on mount + whenever `key`/`url` change (the caller keys them off
// fuel/window/bucket/account — WS8 adds bucket). STALE-WHILE-REVALIDATE: paint the
// cached series for THIS exact key instantly (if warm), then revalidate and swap in
// place. `revalidating` is true while a fetch is in flight AND there's already data
// on screen (drives the shimmer). Returns the LoadState the widget narrows.
export function useIntervalFetch(
  key: string,
  url: string,
): { state: LoadState; revalidating: boolean } {
  const [state, setState] = useState<LoadState>(undefined);
  // `revalidating` (WS2): true while a fetch is in flight AND we already have data
  // on screen — drives the subtle "updating" shimmer instead of a cold skeleton.
  const [revalidating, setRevalidating] = useState(false);

  useEffect(() => {
    let alive = true;

    // NEVER COLD-BLANK. The single state change that makes this true:
    //   • warm cache for THIS key → hydrate state from cache NOW (instant repaint),
    //   • else if we ALREADY have data on screen (any prior Loaded) → keep it up,
    //   • else (genuine first load, nothing to show) → skeleton (state=undefined).
    // Then revalidate in the background and swap in place. We do NOT
    // setState(undefined) for a base reload anymore — that was the old cold-blank.
    const cached = getCached(key);
    setState((prev) => {
      if (cached) return toLoaded(cached); // warm → instant repaint of last-seen series
      if (prev && !('error' in prev)) return prev; // have data → keep it, shimmer over it
      return undefined; // genuine first load → the only cold (skeleton) state left
    });
    // Shimmer whenever we already have something to show (cache hit or prior data);
    // only the true first load (no cache, no prior data) suppresses it for the skeleton.
    setRevalidating(!!cached || (!!state && !('error' in state)));

    // `void` the chain: it's fire-and-forget (state lands via the handlers, guarded by
    // `alive`), so no-floating-promises is satisfied honestly — the .catch() handles
    // failure and there's no unhandled rejection.
    void swrFetch(key, url)
      .then((resp) => {
        if (!alive) return;
        // WS8: swap the rows in WITHOUT any animation. The visible slice of the loaded
        // superset is the SAME data (the view domain is unchanged across an overscan
        // swap), so an instant swap is invisible for a pan and just sharpens-in-place
        // for a finer-grain zoom — no resize/morph. (The WS6 line-morph is removed.)
        setState(toLoaded(resp));
        setRevalidating(false);
      })
      .catch(() => {
        if (!alive) return;
        // On a hard failure keep any stale data we were showing (stale beats blank);
        // only show the error card if we have nothing at all.
        setRevalidating(false);
        setState((prev) => (prev && !('error' in prev) ? prev : { error: true }));
      });
    return () => {
      alive = false;
    };
    // `state` is read only to decide the shimmer flag at fetch START; including it in
    // deps would re-run the effect on every swap (an infinite loop). The fetch
    // identity is fully determined by the `key`/`url` the caller derives from
    // fuel/window/bucket/account (WS8 adds bucket).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, url]);

  return { state, revalidating };
}
