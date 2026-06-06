// Edge-runtime stub for lib/ngrid/bootstrap.ts.
//
// The Next.js instrumentation hook (src/instrumentation.ts) is compiled for both
// the nodejs and edge runtimes, but its real bootstrap implementation depends on
// `node:crypto` + Prisma, which the edge bundler can't resolve. The hook only ever
// CALLS bootstrapEnvLogin() on the nodejs runtime (`NEXT_RUNTIME === 'nodejs'`);
// on edge it returns early. next.config.mjs swaps the real module for this stub in
// the edge compilation, so webpack never traces the node-only graph. This export
// is never invoked at runtime.
export async function bootstrapEnvLogin(): Promise<{ ok: true; skipped: true; reason: string }> {
  return { ok: true, skipped: true, reason: 'edge runtime (no-op stub)' };
}
