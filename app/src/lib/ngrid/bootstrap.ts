// One-time CUTOVER BOOTSTRAP: import the env-based National Grid credential
// (NGRID_USER/NGRID_PASS) into the encrypted `NgLogin` store automatically, so a
// deploy that sets NGRID_SECRET_KEY moves from env-based creds to the store with
// no UI/OTP step. After the import, `resolveCreds()` is store-first (env stays as
// fallback) and the env-bootstrapped accounts (loginId = null) are adopted by the
// new login.
//
// This file is split into TWO layers, deliberately:
//   - `shouldBootstrapEnvLogin()` is PURE and DB-free — the import decision only.
//     It's unit-tested in isolation, so the test suite never imports `@/lib/db`
//     (CI runs vitest in a Docker stage with NO `prisma generate`).
//   - `bootstrapEnvLogin()` is the impure runner (DB + crypto). It NEVER throws.
//     It is invoked from the cron-tick path (lib/scheduler.ts `tickOnce`, hit by
//     the entrypoint's background loop), which is the sole trigger in the built
//     image — Next's instrumentation `register()` hook does NOT fire under
//     `npx next start`, so the cron tick owns the cutover.
//
// Security: the password is never logged or returned. The decrypt round-trip is
// verified BEFORE writing, so we never persist a credential we can't decrypt.
//
// NOTE: this module must NOT import `@/lib/db` at the top level. The pure helper
// `shouldBootstrapEnvLogin` is imported by the unit suite, which runs in a Docker
// stage with NO `prisma generate` — a transitive `@/lib/db` import would fail to
// resolve `@prisma/client`. Prisma is therefore lazy-imported inside the runner.
import { decryptSecret, encryptSecret } from '@/lib/crypto';
import { resolveSecretKeyMaterial } from '@/lib/ngrid/secretKey';
import { VERIFIED } from '@/lib/ngrid/loginStatus';

// Normalize a username for the "already imported?" comparison: trimmed and
// lower-cased, so 'Foo@Example.com ' and 'foo@example.com' are treated as the
// same login and we don't create a duplicate.
function normalizeUsername(username: string): string {
  return username.trim().toLowerCase();
}

export interface BootstrapInputs {
  // Whether NGRID_SECRET_KEY is set (we can't encrypt without it).
  secretKeySet: boolean;
  // The env credentials (NGRID_USER / NGRID_PASS), possibly undefined/empty.
  envUser: string | undefined;
  envPass: string | undefined;
  // Usernames of NgLogin rows that already exist, for the duplicate check.
  existingUsernames: string[];
}

// Pure decision: should we import the env credential into a new NgLogin row?
// True ONLY when:
//   - NGRID_SECRET_KEY is set (so we can encrypt at rest), AND
//   - both NGRID_USER and NGRID_PASS are present (a credential to import), AND
//   - no existing NgLogin already has that username (case-insensitive, trimmed).
// Otherwise false — keeping the runner a cheap no-op on every subsequent start.
export function shouldBootstrapEnvLogin(inputs: BootstrapInputs): boolean {
  const { secretKeySet, envUser, envPass, existingUsernames } = inputs;
  if (!secretKeySet) return false;
  const user = (envUser ?? '').trim();
  const pass = envPass ?? '';
  if (!user || !pass) return false;
  const target = normalizeUsername(user);
  const taken = existingUsernames.some((u) => normalizeUsername(u) === target);
  return !taken;
}

// Result of a runner invocation — small, log-safe (never contains the password).
export type BootstrapResult =
  | { ok: true; skipped: true; reason: string }
  | { ok: true; skipped: false; loginId: number; accountsAdopted: number }
  | { ok: false; skipped: true; reason: string };

// Impure runner: import the env credential into the encrypted store and adopt the
// env-bootstrapped accounts. Safe to run on every startup — idempotent via the
// username-exists check — and wrapped so it NEVER throws into startup.
export async function bootstrapEnvLogin(): Promise<BootstrapResult> {
  try {
    // The encrypt key is ALWAYS resolvable now: env `NGRID_SECRET_KEY` if set,
    // else the persisted/auto-generated key file (see lib/ngrid/secretKey.ts).
    // So the cutover happens on first start with env creds present, no manual
    // env var required. Resolving here also lazily creates the key file if absent.
    const secretKey = resolveSecretKeyMaterial();
    const envUser = process.env.NGRID_USER;
    const envPass = process.env.NGRID_PASS;

    // Cheap pre-checks that don't need the DB (creds present at all). If we
    // already know we won't import, skip the query entirely.
    const user = (envUser ?? '').trim();
    if (!user || !envPass) {
      return { ok: true, skipped: true, reason: 'NGRID_USER / NGRID_PASS not set' };
    }

    // Lazy-import Prisma so the pure-helper consumers (and the unit suite) never
    // pull in `@/lib/db` / `@prisma/client`.
    const { prisma } = await import('@/lib/db');

    const existing = await prisma.ngLogin.findMany({ select: { username: true } });
    if (
      !shouldBootstrapEnvLogin({
        // A key is always resolvable (env or auto-key file), so this is always true.
        secretKeySet: true,
        envUser,
        envPass,
        existingUsernames: existing.map((e) => e.username),
      })
    ) {
      return { ok: true, skipped: true, reason: 'a login for this username already exists' };
    }

    // Encrypt, then VERIFY the round-trip BEFORE persisting. Never write a
    // credential we can't decrypt back to the exact plaintext.
    const enc = encryptSecret(envPass, secretKey);
    if (decryptSecret(enc, secretKey) !== envPass) {
      console.error('[bootstrap] encrypt/decrypt round-trip mismatch — aborting env→NgLogin import');
      return { ok: false, skipped: true, reason: 'decrypt round-trip failed' };
    }

    // Create the login and adopt the env-bootstrapped accounts (loginId = null)
    // atomically: either both happen or neither does.
    const { loginId, accountsAdopted } = await prisma.$transaction(async (tx) => {
      const login = await tx.ngLogin.create({
        data: {
          label: `${user} (imported from env)`,
          username: user,
          ciphertext: enc.ciphertext,
          iv: enc.iv,
          authTag: enc.authTag,
          status: VERIFIED,
          lastVerifiedAt: new Date(),
        },
      });
      const adopted = await tx.account.updateMany({
        where: { loginId: null },
        data: { loginId: login.id },
      });
      return { loginId: login.id, accountsAdopted: adopted.count };
    });

    console.log(
      `[bootstrap] imported env credential into NgLogin id=${loginId}; adopted ${accountsAdopted} account(s)`
    );
    return { ok: true, skipped: false, loginId, accountsAdopted };
  } catch (err) {
    // NEVER throw into startup. Log a concise, password-free message and move on;
    // the env creds remain the working fallback.
    console.error('[bootstrap] env→NgLogin import failed (continuing with env creds):', (err as Error)?.message ?? err);
    return { ok: false, skipped: true, reason: 'unexpected error (see logs)' };
  }
}
