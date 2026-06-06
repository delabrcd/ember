import { describe, expect, it } from 'vitest';
import { decryptSecret, deriveKey, encryptSecret } from '../src/lib/crypto';

// A test key/secret, so these tests never touch process.env.NGRID_SECRET_KEY.
const SECRET = 'test-secret-key-at-least-16-chars-long';
const KEY = deriveKey(SECRET);

describe('crypto: encryptSecret / decryptSecret round-trip', () => {
  it('decrypts back to the original plaintext', () => {
    const plain = 'hunter2';
    expect(decryptSecret(encryptSecret(plain, KEY), KEY)).toBe(plain);
  });

  it('round-trips unicode and shell-special characters', () => {
    for (const plain of ['pää$$word#1', 'naïve-café-☕', 'a$b#c%d&e', '日本語パスワード']) {
      expect(decryptSecret(encryptSecret(plain, KEY), KEY)).toBe(plain);
    }
  });

  it('round-trips the empty string', () => {
    expect(decryptSecret(encryptSecret('', KEY), KEY)).toBe('');
  });
});

describe('crypto: each encryption is randomized', () => {
  it('produces a different IV and ciphertext each time for the same input', () => {
    const a = encryptSecret('same-password', KEY);
    const b = encryptSecret('same-password', KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // ...but both still decrypt to the same plaintext.
    expect(decryptSecret(a, KEY)).toBe('same-password');
    expect(decryptSecret(b, KEY)).toBe('same-password');
  });
});

describe('crypto: tampering and wrong keys are rejected', () => {
  it('throws when the ciphertext is tampered with', () => {
    const enc = encryptSecret('hunter2', KEY);
    const bytes = Buffer.from(enc.ciphertext, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...enc, ciphertext: bytes.toString('base64') };
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it('throws when the auth tag is tampered with', () => {
    const enc = encryptSecret('hunter2', KEY);
    const tag = Buffer.from(enc.authTag, 'base64');
    tag[0] ^= 0xff;
    const tampered = { ...enc, authTag: tag.toString('base64') };
    expect(() => decryptSecret(tampered, KEY)).toThrow();
  });

  it('throws when decrypted with the wrong key', () => {
    const enc = encryptSecret('hunter2', KEY);
    const wrongKey = deriveKey('a-completely-different-secret-value');
    expect(() => decryptSecret(enc, wrongKey)).toThrow();
  });
});

describe('crypto: deriveKey validation', () => {
  it('derives a stable 32-byte key for the same secret', () => {
    const k1 = deriveKey(SECRET);
    const k2 = deriveKey(SECRET);
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });

  it('derives different keys for different secrets', () => {
    expect(deriveKey('secret-number-one-1234').equals(deriveKey('secret-number-two-1234'))).toBe(
      false
    );
  });

  it('throws when the secret is missing', () => {
    expect(() => deriveKey('')).toThrow(/NGRID_SECRET_KEY/);
  });

  it('throws when the secret is too short', () => {
    expect(() => deriveKey('short')).toThrow(/too short/);
  });
});
