// Thin helpers for the repeated boilerplate across app/src/app/api/* routes.
// Nothing here changes a route's behaviour — same statuses, JSON shapes and
// headers — it just removes the copy-pasted account/error dance. Number logic
// stays out of here (it lives in series.ts / parsePdf.ts / prediction.ts).

import { NextResponse } from 'next/server';
import { resolveRequestAccount } from '@/lib/queries';

// NOTE on the `runtime`/`dynamic` flags: Next.js (14.x) requires these as
// statically analyzable string LITERALS in each route file — neither a
// re-export (`export { dynamic } from '@/lib/route'`) nor an imported const
// (`export const runtime = NODE_RUNTIME`) survives its static analysis (it reads
// the identifier name, not the resolved value, and the build hard-errors with
// `Provided runtime "NODE_RUNTIME" is not supported`). So the flag lines stay
// inline in every route; only the account/error/id boilerplate below is factored.

// Standard 400 for a present-but-unknown ?accountId=. Matches the literal the
// read routes have always returned.
export function unknownAccount() {
  return NextResponse.json({ error: 'unknown accountId' }, { status: 400 });
}

// The three-way resolveRequestAccount dance shared by the read routes:
//   'invalid' → 400 { error: 'unknown accountId' }
//   null      → the route's own "no account / empty" payload (parameterized,
//               since each route's empty shape differs: {rows:[]}, {bills:[]},
//               {empty:true}, ...)
//   { id }    → handler({ id }) runs and owns the success response.
// `reqUrl` is req.url (resolveRequestAccount reads ?accountId= off it).
export async function withAccount(
  reqUrl: string,
  empty: () => Response,
  handler: (acct: { id: number }) => Response | Promise<Response>
): Promise<Response> {
  const acct = await resolveRequestAccount(reqUrl);
  if (acct === 'invalid') return unknownAccount();
  if (!acct) return empty();
  return handler(acct);
}

// The repeated catch-all 500 wrapper: { error: String((e as Error)?.message || e) }.
// Same shape and status the write routes have always returned.
export function errorResponse(e: unknown) {
  return NextResponse.json({ error: String((e as Error)?.message || e) }, { status: 500 });
}

// The repeated numeric path-param guard: a non-integer [id] → 400 { error: 'bad id' }.
// Returns the parsed id, or a ready-to-return 400 response.
export function parseIdParam(raw: string): number | Response {
  const id = parseInt(raw, 10);
  if (Number.isNaN(id)) return NextResponse.json({ error: 'bad id' }, { status: 400 });
  return id;
}
