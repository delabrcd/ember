import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  intervalCacheKey,
  getCached,
  setCached,
  swrFetch,
  __clearIntervalCache,
  type IntervalResponse,
} from '../src/lib/intervalCache';

// Unit tests for the client SWR cache backing the Usage-history widget (WS2). The
// cache is a client util (not part of the pure number core), but its behaviour is
// deterministic and testable here without a browser: we stub `globalThis.fetch`
// and toggle `window` to exercise the SSR guard. Each test starts from a clean
// cache so module-level state can't leak between cases.

afterEach(() => {
  __clearIntervalCache();
  vi.restoreAllMocks();
  // Ensure no leaked `window` from an SSR-guard test bleeds into the next.
  delete (globalThis as { window?: unknown }).window;
});

describe('intervalCacheKey', () => {
  it('builds a stable key from fuel|from|to|account|bucket (the params that vary the response)', () => {
    // WS8: an explicit bucket joins the key (trailing segment). Absent bucket → empty.
    expect(
      intervalCacheKey({ fuel: 'ELECTRIC', from: '2026-01-01', to: '2026-02-01', accountId: 7 }),
    ).toBe('ELECTRIC|2026-01-01|2026-02-01|7|');
  });

  it('renders absent window/account/bucket as empty segments (so a default-window call has a stable key)', () => {
    expect(intervalCacheKey({ fuel: 'GAS' })).toBe('GAS||||');
    expect(intervalCacheKey({ fuel: 'GAS', from: null, to: null, accountId: null })).toBe('GAS||||');
  });

  it('WS8: distinguishes the same window at different explicit buckets', () => {
    const base = { fuel: 'ELECTRIC', from: '2026-01-01', to: '2026-02-01', accountId: 7 };
    expect(intervalCacheKey({ ...base, bucket: 3600 })).toBe('ELECTRIC|2026-01-01|2026-02-01|7|3600');
    expect(intervalCacheKey({ ...base, bucket: 900 })).toBe('ELECTRIC|2026-01-01|2026-02-01|7|900');
    // A null bucket keeps the legacy trailing-empty shape (server-picks path).
    expect(intervalCacheKey({ ...base, bucket: null })).toBe('ELECTRIC|2026-01-01|2026-02-01|7|');
  });

  it('does NOT include grain — the client no longer sends it (server picks the bucket)', () => {
    // Two windows that the server would bucket differently still key only by window,
    // never by the resulting grain.
    const a = intervalCacheKey({ fuel: 'ELECTRIC', from: '2026-01-01', to: '2026-01-02' });
    const b = intervalCacheKey({ fuel: 'ELECTRIC', from: '2026-01-01', to: '2026-12-31' });
    expect(a).not.toBe(b);
    expect(a).not.toContain('900');
    expect(b).not.toContain('86400');
  });
});

describe('getCached / setCached', () => {
  it('round-trips a stored response and returns undefined for an unknown key', () => {
    const val: IntervalResponse = { rows: [1, 2, 3], grain: 3600, fifteenMinFrom: null, downsampled: false };
    setCached('k1', val);
    expect(getCached('k1')).toEqual(val);
    expect(getCached('missing')).toBeUndefined();
  });

  it('overwrites the value for an existing key (last write wins)', () => {
    setCached('k', { rows: [1] });
    setCached('k', { rows: [1, 2] });
    expect(getCached('k')?.rows).toHaveLength(2);
  });
});

describe('swrFetch', () => {
  it('SSR guard: never touches the network on the server, returns the cached value (or empty)', async () => {
    // No `window` defined (node env) → server path. A fetch stub would prove a call
    // was made; we assert it is NOT called.
    const fetchStub = vi.fn();
    (globalThis as { fetch?: unknown }).fetch = fetchStub;
    const out = await swrFetch('ssr-key', '/api/interval?fuel=ELECTRIC');
    expect(fetchStub).not.toHaveBeenCalled();
    expect(out).toEqual({ rows: [] }); // nothing cached yet
    // With something cached, the SSR path hands that back unchanged.
    setCached('ssr-key', { rows: [9], grain: 3600 });
    expect(await swrFetch('ssr-key', '/x')).toEqual({ rows: [9], grain: 3600 });
  });

  it('client path: fetches, normalizes, and caches the response', async () => {
    (globalThis as { window?: unknown }).window = {}; // pretend we're in the browser
    const payload = { rows: [{ q: 1 }], grain: 900, fifteenMinFrom: '2026-06-01T00:00:00Z', downsampled: true };
    (globalThis as { fetch?: unknown }).fetch = vi.fn().mockResolvedValue({ json: () => Promise.resolve(payload) });

    const out = await swrFetch('cli-key', '/api/interval?fuel=ELECTRIC');
    expect(out.grain).toBe(900);
    expect(out.fifteenMinFrom).toBe('2026-06-01T00:00:00Z');
    expect(out.downsampled).toBe(true);
    expect(out.rows).toHaveLength(1);
    // It was written to the cache for the next instant repaint.
    expect(getCached('cli-key')?.grain).toBe(900);
  });

  it('client path: dedupes concurrent revalidations onto one in-flight request', async () => {
    (globalThis as { window?: unknown }).window = {};
    const fetchStub = vi
      .fn()
      .mockResolvedValue({ json: () => Promise.resolve({ rows: [], grain: 3600 }) });
    (globalThis as { fetch?: unknown }).fetch = fetchStub;

    const [a, b] = await Promise.all([
      swrFetch('dedupe', '/api/interval'),
      swrFetch('dedupe', '/api/interval'),
    ]);
    expect(fetchStub).toHaveBeenCalledTimes(1); // single network call for both
    expect(a).toEqual(b);
  });

  it('client path: a missing downsampled/grain normalizes to safe defaults', async () => {
    (globalThis as { window?: unknown }).window = {};
    (globalThis as { fetch?: unknown }).fetch = vi
      .fn()
      .mockResolvedValue({ json: () => Promise.resolve({ rows: [] }) });
    const out = await swrFetch('defaults', '/x');
    expect(out.grain).toBeUndefined();
    expect(out.fifteenMinFrom).toBeNull();
    expect(out.downsampled).toBe(false);
    expect(out.rows).toEqual([]);
  });
});
