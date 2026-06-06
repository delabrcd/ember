// Resolves the RAW secret material that lib/crypto.ts scrypts into the AES key
// for the encrypted NgLogin credential store. This is what makes the prod cutover
// automatic: with no `NGRID_SECRET_KEY` env var, we persist an auto-generated key
// to a root-only file so the encrypted store works out of the box.
//
// Resolution order (env always wins so existing installs are unchanged):
//   1. `NGRID_SECRET_KEY` env var, if set and non-blank.
//   2. A persisted key file at `DATA_DIR/session/secret.key`, if it exists.
//   3. Otherwise GENERATE a strong key, write it `0600` (mkdir -p the dir), and
//      return it. This is then stable across restarts (steps 2 → 3 only happen
//      once) — critical, since changing the material would orphan every encrypted
//      credential that was sealed under the old key.
//
// SECURITY: the file is `0600`, lives under the root-only session volume (same
// place the Playwright session is kept), is NEVER logged, and never touches the
// DB or git. The key is read into memory only to derive the AES key.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Filename of the persisted auto-key, alongside the Playwright session under
// `DATA_DIR/session/`. The session dir is already a root-only `0600`-style volume.
const KEY_FILENAME = 'secret.key';
const SESSION_SUBDIR = 'session';

// Default data root, matching lib/ngrid/auth.ts. Read at call time (not import
// time) so a test or the live check can override DATA_DIR before resolving.
function defaultDataDir(): string {
  return process.env.DATA_DIR || '/data';
}

// The absolute path to the persisted key file under a given data dir.
export function secretKeyFilePath(dataDir = defaultDataDir()): string {
  return path.join(dataDir, SESSION_SUBDIR, KEY_FILENAME);
}

// Read a non-blank env secret, or undefined. Trimmed so a stray newline in a
// secrets file doesn't count as "set" while still being effectively blank.
function envSecret(): string | undefined {
  const raw = process.env.NGRID_SECRET_KEY;
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? raw : undefined;
}

// Pure decision: given whether the env secret is set and a file value, decide the
// material WITHOUT doing any I/O. Returns the chosen material and whether a new
// key must be generated+persisted. Kept pure so it is unit-testable DB/FS-free.
export function decideSecretKeyMaterial(input: {
  envSecret: string | undefined;
  fileSecret: string | undefined;
}): { material?: string; generate: boolean } {
  const env = input.envSecret?.trim();
  if (env) return { material: input.envSecret, generate: false };
  const file = input.fileSecret?.trim();
  if (file) return { material: input.fileSecret, generate: false };
  return { generate: true };
}

// Generate a strong 44-char base64 key (32 random bytes), matching the form an
// operator would produce with `openssl rand -base64 32`.
export function generateSecretKeyMaterial(): string {
  return crypto.randomBytes(32).toString('base64');
}

// Read the persisted key file, or undefined if it's absent/blank/unreadable.
// Best-effort: any error is swallowed so a transient FS problem degrades to
// "generate" rather than crashing the caller.
function readKeyFile(file: string): string | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

// Persist freshly-generated key material `0600` (and mkdir -p its dir `0700`).
// Best-effort and contained: returns false on any failure so resolution can still
// return the in-memory material rather than throwing into a caller (e.g. startup).
function writeKeyFile(file: string, material: string): boolean {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // `mode` on writeFileSync only applies when the file is CREATED, and is
    // subject to umask — chmod after to guarantee 0600 even if the file existed.
    fs.writeFileSync(file, material, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

// Resolve the raw secret material: env → persisted file → generate+persist.
// ALWAYS returns a usable string (the encrypted store is therefore always
// available). Never logs the material. Never throws on I/O — a write failure
// still yields a working in-memory key for this process (it just won't be stable
// across restarts until the FS recovers, which we accept over crashing startup).
export function resolveSecretKeyMaterial(dataDir = defaultDataDir()): string {
  const env = envSecret();
  if (env) return env;

  const file = secretKeyFilePath(dataDir);
  const existing = readKeyFile(file);
  if (existing) return existing;

  // Absent: generate once and persist so it's stable across restarts. If the
  // write loses a race (another worker created it first), prefer the on-disk
  // value so all workers converge on the same key.
  const generated = generateSecretKeyMaterial();
  writeKeyFile(file, generated);
  return readKeyFile(file) ?? generated;
}

// Whether a usable key can be resolved at all. With the auto-key this is always
// true (we can generate one), but kept as a function so callers read clearly and
// the decision stays in one place if the policy ever tightens.
export function isSecretKeyAvailable(): boolean {
  return true;
}
