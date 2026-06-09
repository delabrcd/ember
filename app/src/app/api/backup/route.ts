import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/route';
import { tarGz, type ArchiveFile } from '@/lib/archive';
import { collectPdfFiles, runPgDump } from '@/lib/backup';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/backup — a single restorable tar.gz of the whole app: a pg_dump of the
// app DB (db.sql) plus every stored bill PDF (pdfs/<account>/<file>.pdf), enough to
// rebuild on a fresh host (see scripts/restore.sh). Inherits the app's existing
// access posture (LAN-only / reverse-proxy / SSO) — no new auth layer.
//
// SECURITY: the dump contains NG-login passwords only as AES-GCM ciphertext; the
// NGRID_SECRET_KEY that decrypts them is NEVER in the DB and so NEVER in this
// archive (it must be backed up separately — see MANIFEST.txt / README). We never
// log or return the connection string, password, or env; pg_dump runs with the
// password in PGPASSWORD (child env), never argv/stderr.

export async function GET() {
  try {
    const sql = await runPgDump(process.env);
    const pdfs = await collectPdfFiles();

    const now = new Date();
    const manifest =
      `Ember backup\n` +
      `created: ${now.toISOString()}\n` +
      `app version: ${process.env.NEXT_PUBLIC_APP_VERSION || 'unknown'}\n` +
      `db.sql bytes: ${sql.length}\n` +
      `bill PDFs: ${pdfs.length}\n` +
      `\n` +
      `This archive contains AES-GCM-encrypted NG-login credentials. It is USELESS\n` +
      `without NGRID_SECRET_KEY, which is NOT included here — back that key up\n` +
      `separately. Restore: see scripts/restore.sh / README.\n`;

    const files: ArchiveFile[] = [
      { name: 'MANIFEST.txt', data: Buffer.from(manifest, 'utf8') },
      { name: 'db.sql', data: sql },
      ...pdfs,
    ];

    const body = tarGz(files);
    const date = now.toISOString().slice(0, 10);

    return new NextResponse(body, {
      headers: {
        'Content-Type': 'application/gzip',
        'Content-Disposition': `attachment; filename="ember-backup-${date}.tar.gz"`,
        'Content-Length': String(body.length),
      },
    });
  } catch (e) {
    // errorResponse surfaces only e.message; pg_dump errors here can't contain the
    // password (it's passed via PGPASSWORD, never argv/stderr in the discrete path).
    return errorResponse(e);
  }
}
