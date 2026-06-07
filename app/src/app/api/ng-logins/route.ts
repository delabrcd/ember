import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { deriveKey } from '@/lib/crypto';
import { startPreflight } from '@/lib/ngrid/preflight';
import { validateAddLogin } from '@/lib/ngrid/preflightState';
import { isSecretKeyAvailable } from '@/lib/ngrid/secretKey';
import { envCredsUsable, isFirstRun } from '@/lib/ngrid/firstRun';
import { errorResponse } from '@/lib/route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// GET — list stored NG logins. Returns only non-sensitive fields: NEVER the
// password, ciphertext, iv, or auth tag. accountCount is the number of billing
// accounts discovered through each login.
export async function GET() {
  const [logins, accountCount] = await Promise.all([
    prisma.ngLogin.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        label: true,
        username: true,
        status: true,
        lastVerifiedAt: true,
        _count: { select: { accounts: true } },
      },
    }),
    prisma.account.count(),
  ]);
  // First run = a fresh install with nothing to show and nothing to scrape with
  // (see lib/ngrid/firstRun.ts). Such installs get the first-run setup state
  // instead of the empty dashboard; any existing data or credential (stored OR
  // env) means we're past first run and never show it.
  const needsSetup = isFirstRun({
    accountCount,
    loginCount: logins.length,
    envCredsUsable: envCredsUsable(process.env.NGRID_USER, process.env.NGRID_PASS),
  });
  return NextResponse.json({
    // The auto-key (lib/ngrid/secretKey.ts) means a key is always resolvable, so
    // the encrypted store is always available — even with no NGRID_SECRET_KEY.
    secretKeyConfigured: isSecretKeyAvailable(),
    needsSetup,
    logins: logins.map((l) => ({
      id: l.id,
      label: l.label,
      username: l.username,
      status: l.status,
      lastVerifiedAt: l.lastVerifiedAt?.toISOString() ?? null,
      accountCount: l._count.accounts,
    })),
  });
}

// POST — start an interactive pre-flight login for a new credential. Requires
// NGRID_SECRET_KEY (the credential can't be encrypted at rest without it). The
// plaintext password is handed to the pre-flight registry, used for one live
// login, encrypted on success, then dropped — it is never returned or logged.
export async function POST(req: Request) {
  // Fail fast if the encrypted store is unavailable: without the key we can't
  // store the credential, so there's no point starting a real login.
  try {
    deriveKey();
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message || 'NGRID_SECRET_KEY is not configured.' },
      { status: 400 }
    );
  }

  const body = await req.json().catch(() => null);
  const v = validateAddLogin(body);
  if (!v.ok || !v.value) return NextResponse.json({ error: v.error }, { status: 400 });

  try {
    const { id } = startPreflight(v.value);
    return NextResponse.json({ preflightId: id, status: 'RUNNING' });
  } catch (e) {
    return errorResponse(e);
  }
}
