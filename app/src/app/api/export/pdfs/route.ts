import fs from 'fs';
import path from 'path';
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { resolveRequestAccount } from '@/lib/queries';
import { pdfDirForAccount } from '@/lib/ngrid/auth';
import { formatForUserAgent, tarGz, zip, type ArchiveFile } from '@/lib/archive';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET /api/export/pdfs?from=YYYY-MM-DD&to=YYYY-MM-DD&format=zip|tgz[&accountId=]
// Bundles every bill PDF whose statementDate falls in [from, to] (inclusive) for
// the selected account into a single archive. `format` overrides the default;
// otherwise we pick from the User-Agent (tgz for Linux, zip elsewhere). A range
// with no PDFs on disk → 404 JSON (so the browser doesn't save an empty file).

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Validate a YYYY-MM-DD string AND that it's a real calendar date (rejects
// 2026-13-40). Returns the UTC midnight Date or null.
function parseIsoDate(s: string | null): Date | null {
  if (!s || !ISO_DATE.test(s)) return null;
  const d = new Date(s + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  // Round-trip guard against rollover (e.g. 2026-02-30 → 2026-03-02).
  if (d.toISOString().slice(0, 10) !== s) return null;
  return d;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const fromStr = url.searchParams.get('from');
  const toStr = url.searchParams.get('to');
  const formatParam = url.searchParams.get('format');

  const from = parseIsoDate(fromStr);
  const to = parseIsoDate(toStr);
  if (!from || !to) {
    return NextResponse.json({ error: 'from and to must be YYYY-MM-DD dates' }, { status: 400 });
  }
  if (from > to) {
    return NextResponse.json({ error: 'from must be on or before to' }, { status: 400 });
  }
  if (formatParam != null && formatParam !== '' && formatParam !== 'zip' && formatParam !== 'tgz') {
    return NextResponse.json({ error: "format must be 'zip' or 'tgz'" }, { status: 400 });
  }

  const resolved = await resolveRequestAccount(req.url);
  if (resolved === 'invalid') {
    return NextResponse.json({ error: 'unknown accountId' }, { status: 400 });
  }
  if (!resolved) {
    return NextResponse.json({ error: 'no account' }, { status: 404 });
  }

  const account = await prisma.account.findUnique({
    where: { id: resolved.id },
    select: { accountNumber: true },
  });
  if (!account) {
    return NextResponse.json({ error: 'no account' }, { status: 404 });
  }

  // Bills in range with a recorded PDF path, oldest first for a stable archive.
  const bills = await prisma.bill.findMany({
    where: {
      accountId: resolved.id,
      statementDate: { gte: from, lte: to },
      pdfPath: { not: null },
    },
    select: { statementDate: true, pdfPath: true },
    orderBy: { statementDate: 'asc' },
  });

  // Path safety: only ever read from this account's own pdfs/<accountNumber> dir.
  // Resolve each stored pdfPath and confirm it lives under that root before
  // reading; skip anything that doesn't (or is missing on disk).
  const accountDir = path.resolve(pdfDirForAccount(account.accountNumber));
  const files: ArchiveFile[] = [];
  for (const b of bills) {
    if (!b.pdfPath) continue;
    const resolvedPath = path.resolve(b.pdfPath);
    if (resolvedPath !== accountDir && !resolvedPath.startsWith(accountDir + path.sep)) continue;
    if (!fs.existsSync(resolvedPath)) continue;
    const date = b.statementDate.toISOString().slice(0, 10);
    files.push({ name: `${date}.pdf`, data: fs.readFileSync(resolvedPath) });
  }

  if (files.length === 0) {
    return NextResponse.json(
      { error: 'no bill PDFs found in that date range' },
      { status: 404 },
    );
  }

  const format = formatParam === 'zip' || formatParam === 'tgz'
    ? formatParam
    : formatForUserAgent(req.headers.get('user-agent'));

  const ext = format === 'tgz' ? 'tgz' : 'zip';
  const contentType = format === 'tgz' ? 'application/gzip' : 'application/zip';
  const body = format === 'tgz' ? tarGz(files) : zip(files);

  return new NextResponse(body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="ngrid-bills-${fromStr}_${toStr}.${ext}"`,
      'Content-Length': String(body.length),
    },
  });
}
