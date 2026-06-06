import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { decryptSecret } from '@/lib/crypto';
import { deletePdfsForAccounts, deleteSession } from '@/lib/ngrid/auth';
import { passwordMatches, planDeletion } from '@/lib/ngrid/loginStatus';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// DELETE — remove a stored login. The body chooses what happens to its data and
// proves the operator owns the credential:
//
//   { deleteData: boolean, password: string }
//
//   - The typed password is verified server-side by DECRYPTING the stored
//     credential and constant-time-comparing it. A mismatch returns 403, and the
//     password is never logged or echoed back.
//   - deleteData:false (default) → delete only the NgLogin. The FK is
//     onDelete: SetNull, so its accounts (and all bills/usage/costs/weatherDaily)
//     survive; they just lose the login association.
//   - deleteData:true → also delete the login's Account rows (cascade removes
//     their child data) AND remove those accounts' bill PDFs from disk, scoped
//     strictly to each account's own pdfs/<accountNumber> dir.
export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  const id = parseInt(params.id, 10);
  if (Number.isNaN(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });

  const body = (await req.json().catch(() => null)) as
    | { deleteData?: unknown; password?: unknown }
    | null;
  const password = typeof body?.password === 'string' ? body.password : '';
  const deleteData = body?.deleteData === true;
  if (!password) {
    return NextResponse.json(
      { error: 'Your National Grid password is required to confirm removal.' },
      { status: 400 }
    );
  }

  const login = await prisma.ngLogin.findUnique({
    where: { id },
    select: {
      id: true,
      ciphertext: true,
      iv: true,
      authTag: true,
      accounts: { select: { accountNumber: true } },
    },
  });
  if (!login) return NextResponse.json({ error: 'not found' }, { status: 404 });

  // Verify the typed password against the decrypted stored one. The plaintext is
  // used only for this constant-time comparison and dropped immediately; it is
  // never logged or returned. A wrong key (NGRID_SECRET_KEY changed) surfaces as
  // a 500, not a false "wrong password".
  let stored: string;
  try {
    stored = decryptSecret({ ciphertext: login.ciphertext, iv: login.iv, authTag: login.authTag });
  } catch {
    return NextResponse.json(
      { error: 'Could not decrypt the stored credential to verify your password (is NGRID_SECRET_KEY unchanged?).' },
      { status: 500 }
    );
  }
  if (!passwordMatches(stored, password)) {
    return NextResponse.json({ error: 'That password does not match the stored credential.' }, { status: 403 });
  }

  const plan = planDeletion(deleteData);
  const accountNumbers = login.accounts.map((a) => a.accountNumber);

  try {
    if (plan.deleteAccounts) {
      // Delete the accounts first (cascades bills/usage/costs/weatherDaily), then
      // the login. Wrapped in a transaction so a partial failure can't strand
      // half-removed state.
      await prisma.$transaction([
        prisma.account.deleteMany({ where: { loginId: id } }),
        prisma.ngLogin.delete({ where: { id } }),
      ]);
      // Disk cleanup AFTER the DB commit, scoped to exactly these account dirs.
      if (plan.deletePdfs) deletePdfsForAccounts(accountNumbers);
    } else {
      // Keep the data: just delete the login; the FK SET NULL unlinks accounts.
      await prisma.ngLogin.delete({ where: { id } });
    }
  } catch {
    // Prisma throws P2025 when the row is already gone; treat as already-removed.
    return NextResponse.json({ error: 'not found' }, { status: 404 });
  }

  // Drop the login's saved session either way — its cookies are useless now.
  deleteSession(id);

  return NextResponse.json({
    ok: true,
    deletedData: plan.deleteAccounts,
    accountsAffected: accountNumbers.length,
  });
}
