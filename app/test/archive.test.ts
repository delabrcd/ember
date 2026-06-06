import zlib from 'zlib';
import { describe, expect, it } from 'vitest';
import { formatForUserAgent, tar, tarGz, zip, type ArchiveFile } from '../src/lib/archive';

const files: ArchiveFile[] = [
  { name: '2026-01-15.pdf', data: Buffer.from('%PDF-1.4 hello', 'ascii') },
  { name: '2026-02-15.pdf', data: Buffer.from('second file bytes', 'ascii') },
];

// ---- tar / tarGz -----------------------------------------------------------

// Parse one ustar header block: name (NUL-terminated, off 0, 100) and size
// (octal, off 124, 12). Mirrors how `tar` reads it.
function parseTarHeader(block: Buffer) {
  const name = block.toString('ascii', 0, 100).replace(/\0.*$/, '');
  const sizeOctal = block.toString('ascii', 124, 136).replace(/\0.*$/, '').trim();
  const size = parseInt(sizeOctal, 8);
  const type = String.fromCharCode(block[156]);
  return { name, size, type };
}

describe('tar (hand-parsed ustar)', () => {
  it('lays out header + data padded to 512, ending with two zero blocks', () => {
    const buf = tar(files, 0);
    // Two files: each (1 header + 1 data block, since both fit in <512) = 2 blocks,
    // plus 2 trailing zero blocks = 6 blocks total.
    expect(buf.length).toBe(512 * 6);

    const h0 = parseTarHeader(buf.subarray(0, 512));
    expect(h0.name).toBe('2026-01-15.pdf');
    expect(h0.size).toBe(files[0].data.length);
    expect(h0.type).toBe('0'); // regular file
    // Recover the actual file bytes from the data block.
    expect(buf.subarray(512, 512 + h0.size).equals(files[0].data)).toBe(true);

    const h1 = parseTarHeader(buf.subarray(1024, 1536));
    expect(h1.name).toBe('2026-02-15.pdf');
    expect(h1.size).toBe(files[1].data.length);
    expect(buf.subarray(1536, 1536 + h1.size).equals(files[1].data)).toBe(true);

    // Final 1024 bytes (blocks 5 & 6, offset 2048) are the two zero blocks.
    expect(buf.subarray(2048).equals(Buffer.alloc(1024))).toBe(true);
  });

  it('writes a valid ustar checksum', () => {
    const block = tar([files[0]], 0).subarray(0, 512);
    const stored = parseInt(block.toString('ascii', 148, 154), 8);
    const recomputed = Buffer.from(block);
    recomputed.write('        ', 148, 8, 'ascii'); // blank the checksum field
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += recomputed[i];
    expect(stored).toBe(sum);
  });

  it('gunzips back to the exact tar bytes (round-trip)', () => {
    const gz = tarGz(files, 0);
    expect(zlib.gunzipSync(gz).equals(tar(files, 0))).toBe(true);
  });

  it('is deterministic for a fixed mtime', () => {
    expect(tarGz(files, 0).equals(tarGz(files, 0))).toBe(true);
  });
});

// ---- zip (store-only) ------------------------------------------------------

describe('zip (store-only, hand-parsed)', () => {
  it('begins with a local file header signature PK\\x03\\x04', () => {
    const buf = zip(files, 0);
    expect(buf.readUInt32LE(0)).toBe(0x04034b50);
  });

  it('has an EOCD record PK\\x05\\x06 with the right file count', () => {
    const buf = zip(files, 0);
    // EOCD is the last 22 bytes (no comment).
    const eocd = buf.subarray(buf.length - 22);
    expect(eocd.readUInt32LE(0)).toBe(0x06054b50);
    expect(eocd.readUInt16LE(8)).toBe(files.length); // entries on disk
    expect(eocd.readUInt16LE(10)).toBe(files.length); // total entries
  });

  it('stores entries uncompressed and round-trips the first file bytes + CRC', () => {
    const buf = zip([files[0]], 0);
    // Local header: method (off 8) is 0 = stored; sizes (18,22) are equal.
    expect(buf.readUInt16LE(8)).toBe(0);
    const compSize = buf.readUInt32LE(18);
    const uncompSize = buf.readUInt32LE(22);
    expect(compSize).toBe(uncompSize);
    expect(uncompSize).toBe(files[0].data.length);

    const nameLen = buf.readUInt16LE(26);
    const extraLen = buf.readUInt16LE(28);
    const name = buf.toString('utf8', 30, 30 + nameLen);
    expect(name).toBe(files[0].name);

    // Stored bytes follow the name; recover and compare.
    const dataStart = 30 + nameLen + extraLen;
    const stored = buf.subarray(dataStart, dataStart + uncompSize);
    expect(stored.equals(files[0].data)).toBe(true);

    // CRC in the header must match an independent CRC-32 of the data.
    const storedCrc = buf.readUInt32LE(14);
    const expectedCrc =
      typeof (zlib as unknown as { crc32?: (b: Buffer) => number }).crc32 === 'function'
        ? (zlib as unknown as { crc32: (b: Buffer) => number }).crc32(files[0].data)
        : handCrc32(files[0].data);
    expect(storedCrc).toBe(expectedCrc >>> 0);
  });

  it('is deterministic for a fixed mtime', () => {
    expect(zip(files, 0).equals(zip(files, 0))).toBe(true);
  });
});

// Independent CRC-32 used as a fallback when zlib.crc32 isn't available.
function handCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---- formatForUserAgent ----------------------------------------------------

describe('formatForUserAgent', () => {
  it('returns tgz for a desktop Linux UA', () => {
    expect(formatForUserAgent('Mozilla/5.0 (X11; Linux x86_64) Firefox/120.0')).toBe('tgz');
  });

  it('returns zip for Windows and macOS', () => {
    expect(formatForUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('zip');
    expect(formatForUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('zip');
  });

  it('treats Android (linux-based) as zip, not tgz', () => {
    expect(formatForUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel)')).toBe('zip');
  });

  it('defaults to zip for empty/unknown UAs', () => {
    expect(formatForUserAgent('')).toBe('zip');
    expect(formatForUserAgent(null)).toBe('zip');
    expect(formatForUserAgent(undefined)).toBe('zip');
  });
});
