// Connection-derivation + dump helpers behind GET /api/backup. The PURE functions
// at the top (stripPrismaUrlParams, pgConn, pgDumpArgs) replicate the entrypoint's
// `strip_prisma_url_params` + `backup_before_migrate` connection logic in TypeScript
// so we connect to Postgres exactly the same robust way (incl. the #83 special-char
// password path). They take a plain env object, import nothing DB/React/infra at
// module-eval time, and are unit-tested in test/backup.test.ts.
//
// The IMPURE helpers below (runPgDump, collectPdfFiles) spawn pg_dump and walk the
// PDF tree; they're only invoked from the route at request time. Node core modules
// (child_process/fs/path) are fine — the unit suite never calls them.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveFile } from '@/lib/archive';

// dataDir() lives in lib/ngrid/auth, which imports the Prisma client at module
// load. The unit suite runs WITHOUT `prisma generate`, so importing it at the top
// would break the hermetic tests for the pure functions in this file. It's only
// needed by the impure collectPdfFiles() below, so we pull it in lazily there.

// The subset of process.env the connection logic reads. An index signature keeps
// it structurally compatible with NodeJS.ProcessEnv so the route can pass
// `process.env` directly, while the named keys document what's actually read.
// Passed in explicitly so the pure functions stay testable.
export interface BackupEnv {
  DATABASE_URL?: string;
  DB_PASSWORD?: string;
  DB_USER?: string;
  DB_NAME?: string;
  [key: string]: string | undefined;
}

// Prisma-only query params libpq rejects (it errors on ANY unrecognized param).
// Mirrors the `case` list in docker-entrypoint.sh:strip_prisma_url_params.
const PRISMA_ONLY_PARAMS = new Set([
  'schema',
  'connection_limit',
  'pool_timeout',
  'pgbouncer',
  'socket_timeout',
  'statement_cache_size',
  'sslidentity',
]);

// Drop Prisma-only query params (and empty fragments like a trailing `&`) from a
// postgres:// URL so it's a valid libpq conninfo, keeping libpq-valid params
// (sslmode, connect_timeout, sslcert, …). No query string → returned unchanged.
// Faithful port of the bash: split once on the first `?`, split the query on `&`,
// keep `key=value` pairs whose key isn't Prisma-only and isn't empty.
export function stripPrismaUrlParams(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const base = url.slice(0, q);
  const query = url.slice(q + 1);
  const kept: string[] = [];
  for (const pair of query.split('&')) {
    const key = pair.split('=')[0];
    if (key === '') continue; // empty fragment (e.g. trailing &)
    if (PRISMA_ONLY_PARAMS.has(key)) continue; // Prisma-only — drop it
    kept.push(pair);
  }
  return kept.length ? `${base}?${kept.join('&')}` : base;
}

// The discrete libpq connection arguments + optional PGPASSWORD, derived the same
// two ways as the entrypoint and shared by pg_dump/psql invocations:
//
//   DB_PASSWORD set  → discrete `-h <host> -p <port> -U <user> -d <db>` with the host
//     and port sliced from the URL authority AFTER the last `@` and BEFORE the first
//     `/` (neither can contain the password's special chars), default port 5432,
//     user=DB_USER||'ngrid', db=DB_NAME||'ngrid', plus PGPASSWORD=<raw DB_PASSWORD>.
//     This is the #83 path: a password with @/#/$/% breaks libpq URL parsing, so we
//     feed the raw password and never put it in argv.
//
//   DB_PASSWORD unset/empty → a single conninfo arg = stripPrismaUrlParams(DATABASE_URL),
//     with NO PGPASSWORD (the URL carries the credential; libpq decodes it).
export function pgConn(env: BackupEnv): { args: string[]; extraEnv: Record<string, string> } {
  const databaseUrl = env.DATABASE_URL ?? '';
  const dbPassword = env.DB_PASSWORD ?? '';
  if (dbPassword !== '') {
    // authority = host:port (everything after the last '@', before the first '/').
    let authority = databaseUrl.slice(databaseUrl.lastIndexOf('@') + 1);
    const slash = authority.indexOf('/');
    if (slash !== -1) authority = authority.slice(0, slash);
    const colon = authority.lastIndexOf(':');
    const host = colon === -1 ? authority : authority.slice(0, colon);
    const port = colon === -1 ? '5432' : authority.slice(colon + 1);
    const user = env.DB_USER || 'ngrid';
    const db = env.DB_NAME || 'ngrid';
    return {
      args: ['-h', host, '-p', port, '-U', user, '-d', db],
      extraEnv: { PGPASSWORD: dbPassword },
    };
  }
  return { args: [stripPrismaUrlParams(databaseUrl)], extraEnv: {} };
}

// Full pg_dump argv. `--no-owner --no-privileges --clean --if-exists` make the dump
// restore cleanly into a FRESH stack regardless of the role it's loaded as.
export function pgDumpArgs(env: BackupEnv): { args: string[]; extraEnv: Record<string, string> } {
  const { args, extraEnv } = pgConn(env);
  return {
    args: ['--no-owner', '--no-privileges', '--clean', '--if-exists', ...args],
    extraEnv,
  };
}

// ---- impure helpers (request-time only) ------------------------------------

// Spawn pg_dump and capture stdout to a Buffer; reject on a non-zero exit. The
// PGPASSWORD (when set) goes through extraEnv into the child env, never argv — so
// it can't leak into argv or stderr. We surface stderr in the rejection message
// only; in the DB_PASSWORD path that stderr never contains the password.
export function runPgDump(env: BackupEnv): Promise<Buffer> {
  const { args, extraEnv } = pgDumpArgs(env);
  return new Promise((resolve, reject) => {
    const child = spawn('pg_dump', args, {
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out));
      } else {
        const msg = Buffer.concat(err).toString('utf8').trim();
        reject(new Error(`pg_dump exited ${code}${msg ? `: ${msg}` : ''}`));
      }
    });
  });
}

// Walk `${dataDir()}/pdfs` and return every file as an ArchiveFile named
// `pdfs/<relativePath>`. Each candidate path is resolved and confirmed to stay
// under the pdfs root before reading (path-safety, mirroring export/pdfs/route.ts).
// A missing pdfs dir → no files (a brand-new install has none yet).
export async function collectPdfFiles(): Promise<ArchiveFile[]> {
  const { dataDir } = await import('@/lib/ngrid/auth');
  const root = path.resolve(dataDir(), 'pdfs');
  const files: ArchiveFile[] = [];
  if (!fs.existsSync(root)) return files;

  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const resolved = path.resolve(full);
      // Defense-in-depth: never follow a symlink/entry out of the pdfs root.
      if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = path.relative(root, resolved).split(path.sep).join('/');
        files.push({ name: `pdfs/${rel}`, data: fs.readFileSync(resolved) });
      }
    }
  };
  walk(root);
  // Stable order for a deterministic archive.
  files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return files;
}
