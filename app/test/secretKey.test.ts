import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideSecretKeyMaterial,
  generateSecretKeyMaterial,
  resolveSecretKeyMaterial,
  secretKeyFilePath,
} from '../src/lib/ngrid/secretKey';

// Pure decision helper — no I/O, no env.
describe('decideSecretKeyMaterial (pure)', () => {
  it('prefers the env secret when set', () => {
    expect(decideSecretKeyMaterial({ envSecret: 'env-secret', fileSecret: 'file-secret' })).toEqual({
      material: 'env-secret',
      generate: false,
    });
  });

  it('treats a blank/whitespace env secret as unset and falls back to the file', () => {
    expect(decideSecretKeyMaterial({ envSecret: '   ', fileSecret: 'file-secret' })).toEqual({
      material: 'file-secret',
      generate: false,
    });
  });

  it('uses the file secret when env is absent', () => {
    expect(decideSecretKeyMaterial({ envSecret: undefined, fileSecret: 'file-secret' })).toEqual({
      material: 'file-secret',
      generate: false,
    });
  });

  it('signals generate when neither env nor file is present', () => {
    expect(decideSecretKeyMaterial({ envSecret: undefined, fileSecret: undefined })).toEqual({
      generate: true,
    });
    expect(decideSecretKeyMaterial({ envSecret: '', fileSecret: '  ' })).toEqual({ generate: true });
  });
});

describe('generateSecretKeyMaterial', () => {
  it('produces a 44-char base64 string (32 random bytes) that differs each call', () => {
    const a = generateSecretKeyMaterial();
    const b = generateSecretKeyMaterial();
    expect(a).toHaveLength(44); // base64 of 32 bytes
    expect(Buffer.from(a, 'base64')).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});

// File-generation is impure; exercise it against a temp dir so we never touch the
// real DATA_DIR. The env var is cleared so the file path is taken.
describe('resolveSecretKeyMaterial (file generate + persist)', () => {
  let tmp: string;
  const savedEnv = process.env.NGRID_SECRET_KEY;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ngkey-'));
    delete process.env.NGRID_SECRET_KEY;
  });
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.NGRID_SECRET_KEY;
    else process.env.NGRID_SECRET_KEY = savedEnv;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('generates a 0600 key file when absent and returns its material', () => {
    const file = secretKeyFilePath(tmp);
    expect(fs.existsSync(file)).toBe(false);
    const material = resolveSecretKeyMaterial(tmp);
    expect(material.length).toBeGreaterThanOrEqual(16);
    expect(fs.existsSync(file)).toBe(true);
    // Permissions are 0600 (owner read/write only).
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // What's on disk matches what was returned.
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(material);
  });

  it('is STABLE across calls — does not regenerate once persisted', () => {
    const first = resolveSecretKeyMaterial(tmp);
    const second = resolveSecretKeyMaterial(tmp);
    expect(second).toBe(first);
  });

  it('prefers the env secret over the persisted file', () => {
    const fileMaterial = resolveSecretKeyMaterial(tmp); // creates the file
    process.env.NGRID_SECRET_KEY = 'an-explicit-env-secret-value';
    expect(resolveSecretKeyMaterial(tmp)).toBe('an-explicit-env-secret-value');
    expect(resolveSecretKeyMaterial(tmp)).not.toBe(fileMaterial);
  });

  it('reads back an existing file rather than generating a new key', () => {
    const file = secretKeyFilePath(tmp);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'pre-existing-secret-material', { mode: 0o600 });
    expect(resolveSecretKeyMaterial(tmp)).toBe('pre-existing-secret-material');
  });
});
