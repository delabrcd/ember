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
//
// The whole thing (resolution + the empty/handler callbacks) is wrapped in
// `errorResponse`, so an unexpected throw — a Prisma blip in `handler`, etc. —
// surfaces as the SAME { error } + 500 envelope the write/management routes
// return, rather than Next's default unstructured 500 (issue #159). Callers
// therefore do NOT need their own try/catch around the handler body; the few
// that still have one (a route that wants a NON-500 status on a specific failure)
// keep it deliberately, and it just runs inside this guard.
export async function withAccount(
  reqUrl: string,
  empty: () => Response,
  handler: (acct: { id: number }) => Response | Promise<Response>
): Promise<Response> {
  try {
    const acct = await resolveRequestAccount(reqUrl);
    if (acct === 'invalid') return unknownAccount();
    if (!acct) return empty();
    return await handler(acct);
  } catch (e) {
    return errorResponse(e);
  }
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
