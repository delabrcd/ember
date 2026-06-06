// Dependency-free, pure archive writers used to bundle a range of bill PDFs into
// a single download. No DB/fs/network here — everything is in-memory Buffer math
// so the unit suite stays DB-free (CI runs tests without `prisma generate`).
//
// Two formats, both deterministic given a fixed `mtime` (default 0) so the same
// inputs always produce identical bytes (reproducible + testable):
//   - tarGz: a minimal POSIX/ustar tar, then gzipped via Node's zlib.
//   - zip:   a store-only (method 0, no compression) zip. PDFs are already
//            compressed, so storing avoids redundant work and keeps it simple.
import zlib from 'zlib';

export interface ArchiveFile {
  name: string;
  data: Buffer;
}

export type ArchiveFormat = 'zip' | 'tgz';

// Pick a default archive format from the requester's User-Agent: a tgz for
// Linux (where `tar -xzf` is the native idiom), a zip for Windows/macOS/anything
// else (double-clickable). Pure + case-insensitive; an empty/unknown UA → zip.
export function formatForUserAgent(ua: string | null | undefined): ArchiveFormat {
  const s = (ua ?? '').toLowerCase();
  // Match Linux but not Android (Android UAs contain "linux" yet aren't desktop
  // Linux and have no native tar workflow).
  if (s.includes('linux') && !s.includes('android')) return 'tgz';
  return 'zip';
}

// ---- tar (POSIX/ustar) -----------------------------------------------------

// Write `value` left-justified into `buf[offset..offset+len)` as ASCII, the rest
// already zero-filled by Buffer.alloc.
function writeAscii(buf: Buffer, value: string, offset: number, len: number): void {
  buf.write(value.slice(0, len), offset, len, 'ascii');
}

// Octal field: `len-1` digits, zero-padded, then a trailing NUL (the ustar
// convention used by GNU/BSD tar).
function writeOctal(buf: Buffer, value: number, offset: number, len: number): void {
  const oct = value.toString(8);
  const padded = oct.padStart(len - 1, '0').slice(-(len - 1));
  buf.write(padded, offset, len - 1, 'ascii');
  buf[offset + len - 1] = 0;
}

const BLOCK = 512;

// One 512-byte ustar header for a regular file. The checksum is computed with
// the checksum field treated as eight spaces, then written back as octal.
function tarHeader(name: string, size: number, mtime: number): Buffer {
  const h = Buffer.alloc(BLOCK);
  writeAscii(h, name, 0, 100); // name
  writeOctal(h, 0o644, 100, 8); // mode
  writeOctal(h, 0, 108, 8); // uid
  writeOctal(h, 0, 116, 8); // gid
  writeOctal(h, size, 124, 12); // size
  writeOctal(h, mtime, 136, 12); // mtime
  h.write('        ', 148, 8, 'ascii'); // checksum field = 8 spaces while summing
  h[156] = '0'.charCodeAt(0); // typeflag '0' = regular file
  h.write('ustar\0', 257, 6, 'ascii'); // magic
  h.write('00', 263, 2, 'ascii'); // version

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  // Classic ustar checksum: 6 octal digits, NUL, space.
  const cs = sum.toString(8).padStart(6, '0').slice(-6);
  h.write(cs, 148, 6, 'ascii');
  h[154] = 0;
  h[155] = ' '.charCodeAt(0);
  return h;
}

// Pad a buffer up to the next 512-byte boundary with zeros.
function padTo512(len: number): Buffer {
  const rem = len % BLOCK;
  return rem === 0 ? Buffer.alloc(0) : Buffer.alloc(BLOCK - rem);
}

// Build an uncompressed tar of the given files (header + data + padding each),
// terminated by two zero blocks.
export function tar(files: ArchiveFile[], mtime = 0): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(tarHeader(f.name, f.data.length, mtime));
    parts.push(f.data);
    parts.push(padTo512(f.data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2)); // end-of-archive: two zero blocks
  return Buffer.concat(parts);
}

// Tar, then gzip. Level 9 + fixed (no) mtime keeps the output deterministic.
export function tarGz(files: ArchiveFile[], mtime = 0): Buffer {
  return zlib.gzipSync(tar(files, mtime), { level: 9 });
}

// ---- zip (store-only) ------------------------------------------------------

// Standard CRC-32 (IEEE 802.3, reflected), table built once on first use.
let crcTable: Uint32Array | null = null;
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = crcTable[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// MS-DOS date/time encoding of `mtime` (epoch seconds, UTC). Values below the
// 1980 DOS epoch clamp to 1980-01-01 00:00:00 (what tooling expects).
function dosDateTime(mtime: number): { time: number; date: number } {
  const d = new Date(mtime * 1000);
  let year = d.getUTCFullYear();
  let month = d.getUTCMonth() + 1;
  let day = d.getUTCDate();
  let hours = d.getUTCHours();
  let minutes = d.getUTCMinutes();
  let seconds = d.getUTCSeconds();
  if (year < 1980) {
    year = 1980;
    month = 1;
    day = 1;
    hours = minutes = seconds = 0;
  }
  const time = (hours << 11) | (minutes << 5) | (seconds >> 1);
  const date = ((year - 1980) << 9) | (month << 5) | day;
  return { time, date };
}

// A store-only (method 0) zip: a local header + data per file, then the central
// directory, then the end-of-central-directory record.
export function zip(files: ArchiveFile[], mtime = 0): Buffer {
  const { time, date } = dosDateTime(mtime);
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0; // running offset of each local header within the file

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const size = f.data.length;

    // Local file header (30 bytes + name), method 0 (stored), no data descriptor.
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // PK\x03\x04
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method 0 = stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18); // compressed size == size (stored)
    local.writeUInt32LE(size, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, nameBuf, f.data);

    // Central directory header (46 bytes + name).
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); // PK\x01\x02
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8); // flags
    central.writeUInt16LE(0, 10); // method
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + f.data.length;
  }

  const localBlob = Buffer.concat(localParts);
  const centralBlob = Buffer.concat(centralParts);

  // End of central directory record (22 bytes, no archive comment).
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir start disk
  eocd.writeUInt16LE(files.length, 8); // entries on this disk
  eocd.writeUInt16LE(files.length, 10); // total entries
  eocd.writeUInt32LE(centralBlob.length, 12); // central dir size
  eocd.writeUInt32LE(localBlob.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localBlob, centralBlob, eocd]);
}
