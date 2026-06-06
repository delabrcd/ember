// Next.js instrumentation hook — runs once when the server process starts.
// We use it to run the one-time env→NgLogin cutover bootstrap (see
// lib/ngrid/bootstrap.ts): on the first start after NGRID_SECRET_KEY is set, the
// env credential (NGRID_USER/NGRID_PASS) is imported into the encrypted store and
// existing env-bootstrapped accounts are adopted. It's a near-instant no-op once
// already bootstrapped, or when NGRID_SECRET_KEY is unset.
//
// IMPORTANT: this hook does NOT fire under `npx next start` in the production
// image, so it is NOT the reliable trigger. The cutover is actually driven from
// the cron-tick path (lib/scheduler.ts `tickOnce`, hit by the entrypoint loop
// ~25s after boot). This hook is kept as a harmless extra call (e.g. `next dev`);
// `bootstrapEnvLogin()` is idempotent so running it from both places is safe.
//
// Gated to the Node.js runtime: the bootstrap touches Prisma + node:crypto, which
// don't exist on the Edge runtime. Enabled via experimental.instrumentationHook
// in next.config.mjs (required for Next 14.2).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  // Dynamic import so the Prisma/crypto graph is never pulled into an Edge bundle.
  const { bootstrapEnvLogin } = await import('@/lib/ngrid/bootstrap');
  await bootstrapEnvLogin();
}
