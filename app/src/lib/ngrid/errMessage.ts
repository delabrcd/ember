// PURE error-message helper (no DB / Playwright / fs).
//
// Replaces the ~11 hand-rolled `String(err?.message || err).slice(0, max)` sites in
// the scheduler runner + handlers. Takes an `unknown` (so the catch can be
// `catch (err: unknown)`) and reproduces that expression BYTE-FOR-BYTE: prefer a
// truthy `.message`, else fall back to the value itself, `String(...)` the result,
// and truncate to `max` chars. (A falsy `.message` — e.g. '' — falls through to the
// value exactly like `||` did, so `String(err)` wins there too.) Unit-tested
// (test/errMessage.test.ts).
//
// SECURITY (standards §3): this only ever stringifies an Error/value's own message —
// it never decrypts, reads creds, or reaches for secret material. Callers must not
// pass a decrypted password in as `err`; nothing here would surface one on its own.
export function errMessage(err: unknown, max = 200): string {
  // `(err as { message?: unknown })?.message` safely reads `.message` off any value
  // (undefined for primitives/null); `|| err` reproduces the original truthy-or
  // fallback, and String()+slice the final value — identical to the inline sites.
  const picked = (err as { message?: unknown } | null | undefined)?.message || err;
  return String(picked).slice(0, max);
}
