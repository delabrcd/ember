// Reversible secret encryption for stored National Grid credentials.
//
// The Playwright login needs the *plaintext* password, so we can't hash — we
// encrypt at rest with AES-256-GCM and decrypt just-in-time for a scrape. The
// 32-byte key is DERIVED from the `NGRID_SECRET_KEY` env var (never stored in
// the DB) via scrypt over a constant app salt: scrypt is deliberately slow and
// salted, so two installs with the same secret don't share a raw key and a leaked
// secret isn't trivially brute-forced. The salt is fixed (not secret) because the
// secret already carries the entropy; per-secret random salts would have to be
// persisted somewhere, defeating the "key only in env" rule.
//
// This module is PURE given the key: every function accepts an optional explicit
// key so tests don't depend on the environment. Only `deriveKey` reads env.
import crypto from 'node:crypto';

// Fixed, non-secret application salt for the scrypt KDF. Changing this value
// invalidates every previously-encrypted row, so treat it as a constant.
const KEY_SALT = 'ngrid-dashboard/cred-store/v1';

// Minimum length for the raw secret. `openssl rand -base64 32` yields 44 chars;
// we accept anything reasonably long so operators aren't forced to a single form.
const MIN_SECRET_LEN = 16;

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM's standard nonce length.
const KEY_BYTES = 32; // aes-256.

export interface EncryptedSecret {
  ciphertext: string; // base64
  iv: string; // base64
  authTag: string; // base64
}

// Derive the 32-byte AES key from a raw secret. Throws if the secret is missing
// or too short. Reads `NGRID_SECRET_KEY` when no secret is passed.
export function deriveKey(secret?: string): Buffer {
  const raw = secret ?? process.env.NGRID_SECRET_KEY;
  if (!raw) {
    throw new Error(
      'NGRID_SECRET_KEY is not set — required to encrypt/decrypt stored National Grid credentials. ' +
        'Generate one with `openssl rand -base64 32`.'
    );
  }
  if (raw.length < MIN_SECRET_LEN) {
    throw new Error(`NGRID_SECRET_KEY is too short (need at least ${MIN_SECRET_LEN} characters).`);
  }
  return crypto.scryptSync(raw, KEY_SALT, KEY_BYTES);
}

// Resolve a usable 32-byte key from either an explicit key/secret or the env.
// Accepting a Buffer lets callers (and tests) skip the KDF entirely.
function resolveKey(key?: Buffer | string): Buffer {
  if (Buffer.isBuffer(key)) {
    if (key.length !== KEY_BYTES) throw new Error(`encryption key must be ${KEY_BYTES} bytes`);
    return key;
  }
  return deriveKey(key);
}

// Encrypt a plaintext secret. A fresh random 12-byte IV is generated per call,
// so encrypting the same value twice yields different ciphertext. Returns all
// three components base64-encoded. Pass an explicit key/secret for tests.
export function encryptSecret(plaintext: string, key?: Buffer | string): EncryptedSecret {
  const k = resolveKey(key);
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, k, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

// Decrypt a previously-encrypted secret. Throws if the ciphertext or auth tag has
// been tampered with, or if the key is wrong (GCM verifies the tag on final()).
export function decryptSecret(enc: EncryptedSecret, key?: Buffer | string): string {
  const k = resolveKey(key);
  const decipher = crypto.createDecipheriv(ALGORITHM, k, Buffer.from(enc.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(enc.authTag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(enc.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}
