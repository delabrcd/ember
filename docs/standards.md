# Engineering Standards

The binding rules for any change to Ember — human or AI. These are *requirements*, not
suggestions. [AGENTS.md](../AGENTS.md) and [CONTRIBUTING.md](../CONTRIBUTING.md) are the
short entry points; this is the canonical, enforceable version. The companion
[architecture.md](architecture.md) explains *how the system is shaped* and *where things
live* — read it alongside this when you need the map.

If a change can't satisfy a rule below, stop and raise it — don't work around the rule.

---

## 1. Data accuracy is the prime directive

This app exists to tell the operator the truth about their energy bills. A plausible-but-wrong
number is worse than no number.

- **The bill PDF is the source of truth, not the API.** Some API fields are plausible but wrong
  for analysis. The canonical period energy cost is **`Bill.currentCharges`** (parsed from the
  PDF) — **never `totalDueAmount`** (the statement *Amount Due*, which can fold in a carried-over
  balance).
- **Any change that touches a number must keep `GET /api/verify` green** on a real account, and the
  summary must be pasted into the PR. `/api/verify` re-parses the PDFs and cross-checks parsed vs
  API vs stored values. (Caveat: it currently checks a **single account** — the lowest-id one — so on
  a multi-account install run it per account, and don't read a green result as covering every
  premise.)
- **Every new numeric/parse function ships with a hand-calculated unit test** — a fixture where you
  worked the expected value out by hand, not a snapshot of whatever the code currently returns.
- **Never fabricate data to fill a gap.** Missing intervals render as line *breaks*
  (`connectNulls=false`), never as zeros. Provisional AMI zeros are *filled* on re-scrape only under
  a guarded conditional upsert (`stored.quantity=0 AND incoming<>0`); an established non-zero reading
  is write-once and never clobbered. Display-only decimation (`viz/downsampleInterval.ts`) is allowed
  and clearly labelled; it never feeds `/api/verify`, the monthly series, or any billed-cost number.

## 2. Pure core, impure shell

The architecture splits **pure logic you can unit-test** from **I/O you can't**. Keep that split.

- **Number / parse / prediction / shaping logic is a pure function** with no DB, browser, network,
  or React dependency. Canonical homes: `lib/ngrid/parsePdf.ts` (parsing), `lib/series.ts`
  (aggregation + rates), `lib/prediction.ts` (forecasting), plus the focused pure libs
  (`lib/range.ts`, `lib/ym.ts`, `lib/emissions.ts`, `lib/weather/degreeDays.ts`,
  `lib/scheduler/{cadence,projection}.ts`, …). **Do not bury arithmetic in a component or an API
  route.**
- **The unit suite must stay hermetic.** Pure libs may import Prisma **types** (`import type { … }`)
  but must not import the client, Playwright, `@/lib/db`, or anything that does I/O. The Docker
  `test` stage runs with no DB and no browser — if a pure helper drags in infra, it breaks CI for
  everyone.
- **Impure handlers fetch, then call the pure function, then persist.** The pattern is: a thin
  impure shell (an API route, a scheduler handler, a React hook) gathers raw data, hands it to a
  pure function, and writes the result back. See `architecture.md` §"Pure core vs impure shell" for
  worked examples.

## 3. Security & secrets

- **Credentials are AES-256-GCM encrypted at rest** in the `NgLogin` table (`lib/crypto.ts`). The
  key material is resolved by `lib/ngrid/secretKey.ts`: the `NGRID_SECRET_KEY` env var wins; absent
  that, a persisted auto-generated key at `/data/session/secret.key` is used; absent that, one is
  generated and persisted. **Changing the key material orphans every stored credential** — treat
  `secret.key` as recovery-critical: persist `/data` and include it in your backups (losing it means
  every stored credential must be re-entered).
- **Never log or return a decrypted password to the client.** Decrypt just-in-time for the scraper,
  in memory, and never serialize it into a response, a log line, or an error.
- **Nothing secret or personal hits git.** `.env`, `data/`, the saved Playwright session, bill PDFs,
  and any account number / address / domain are gitignored — keep it that way. Check `git status`
  before committing.
- **No public app-auth layer, by design.** Ember exposes financial data and is meant to run LAN-only
  or behind a reverse proxy / SSO. Don't add a public login, and don't write instructions to expose
  it un-gated. The in-app **NG-login management UI** is allowed but inherits the existing access gate
  — it is not an application login.

## 4. Be a good guest to National Grid

The scraper hits a third party with a real account. Gentleness is a hard rule, not a nicety.

- **Reuse the session** (`PortalSession`); one login per tick, shared across all portal tasks.
- **Keep the rate-limiting / jitter and the "tighten near the predicted bill, back off otherwise"
  cadence.** Never add tight polling or parallel logins.
- **Never trigger a real scrape from CI, from verification, or from any non-production environment.**
  Run secondary environments with the scheduler OFF and placeholder credentials. Build scraper
  changes to degrade safely, unit-test the pure parts, and **flag what needs human verification
  against a real account** rather than hitting the portal yourself.

## 5. Use the declarative patterns — don't fork bespoke ones

- **Charts are declarative.** Add or change a chart by editing the spec in `lib/chartSpec.ts`
  (`CHART_SPECS`); the generic `ConfigurableChart` renders it and derives its config menu. Don't
  write a one-off chart component.
- **Stat cards and widgets go through the registry** (`lib/widgets/registry.tsx`,
  `lib/widgets/statSpec.ts`). New widgets must be gated on `isPlaced` like the others (a forced
  unconditional append both breaks removal and can overflow the fit layout — this bit us before; the
  registry documents the pitfall).
- **A new scheduler behaviour is a `TASK_DEFS` entry + a handler `run()`** — nothing else. No switch
  statements: portal flag, run order, UI label, cadence, and trigger wording all live in the
  per-task descriptor (`lib/scheduler/tasks.ts`). If you find yourself adding a `case` on `TaskKind`,
  the data belongs in the registry instead.
- **Prefs vs settings.** Per-user display preferences → `lib/prefs.tsx` (localStorage). Server-wide
  runtime settings (scheduler toggle, budget target, …) → the `AppSetting` table + `/api/settings`.
- **The UI does not know about task internals.** It reads display-ready data from the server
  (`/api/schedule/upcoming` returns resolved `{ at, label, detail }`); it does not import `TASK_DEFS`
  or reconstruct cadence client-side.

## 6. The data model is additive on a no-rollback prod

- **Schema changes are additive.** New tables/columns/indexes only. The deploy entrypoint applies the
  schema with `prisma db push --accept-data-loss` and **there is no rollback** — a destructive change
  silently deletes production rows.
- **The audit/data tables are append-only.** `Bill`, `Usage`, `Cost`, `IntervalUsage`, `Weather`,
  `WeatherDaily`, `Notification` accrete rows (upserted in place under guarded conditions, never
  deleted) — this preserves the audit trail and lets `/api/verify` re-check history. By contrast
  `ScheduledTask` and `ScrapeRun` are **mutable working/run state** (rewritten every tick:
  `nextRunAt`/`lastStatus`, `status RUNNING→SUCCESS`), and `AppSetting` is mutable key/value — don't
  treat those three as immutable history.
- **The migration-safety CI gate must pass.** It seeds the *previous release's* schema, applies the
  current one, and proves data survives. A schema change that can't pass this gate doesn't ship.
  Caveat: it diffs only against the previous **release tag**, so it is a no-op when two releases share
  a schema — a destructive edit merged to `main` but not yet released hits `:edge`/non-prod installs
  with weaker protection (only the entrypoint backup, which itself no-ops when `migrate diff` sees no
  delta vs the live DB). Tagged-release deploys carry the strongest guarantee.
- **A schema-changing deploy must produce a pre-migrate backup** (the entrypoint's
  `backup_before_migrate()` writes `ngrid-pre-migrate-*.sql.gz` before `db push`). It fails closed:
  if it can't probe the DB, it aborts rather than migrate unprotected.

## 7. Verify the CI way, not the dev-machine way

- **The real test path is the Docker `test` stage**, not a host `vitest`:
  `docker build --target test -t ember-test ./app && docker run --rm ember-test`. Dev machines hide
  failures (a generated Prisma client present locally but not in the image; a startup hook that fires
  in `next dev` but not under the prod server).
- **The publish is gated on five jobs** (`test`, `lint`, `migration-safety`, `smoke-boot`,
  `entrypoint-backup`) all green. Don't expect to merge around a red gate.
- **`smoke-boot` boots the shipped runner image** against a throwaway Postgres and asserts
  `/api/overview` serves real data — it catches startup/DB/query breakage a unit test can't.

## 8. Code style & conventions

- **TypeScript throughout; keep the strict build clean** (`tsc --noEmit` is a CI gate). Match the
  surrounding file's style — comment density, naming, idioms.
- **No new dependency without a reason.** The dependency set is deliberately small (`next`, `react`,
  `recharts`, `@prisma/client`, `playwright`, `nodemailer`, `react-grid-layout`).
- **API routes** use `export const runtime = 'nodejs'` and `export const dynamic = 'force-dynamic'`.
- **Don't hand-edit `app/package.json` `version`** — it's a `0.0.0` placeholder stamped from the git
  tag at build time.
- **Commits:** clear imperative messages; author as **yourself**; this repo keeps AI/co-author
  trailers **off** — no `Co-Authored-By` trailer.

## 9. Make it green honestly — fix the root cause, never mask the check

A clean lint/typecheck/test run must come from *fixing the underlying issue*, not silencing it. Do
**not** blanket-disable lint rules, scatter `eslint-disable`, `@ts-ignore` / `any`-away type errors,
`.skip`/`xfail` a failing test, or loosen a threshold / delete an assertion to pass. A
narrowly-scoped, justified suppression (one line, with a comment explaining why the rule is genuinely
wrong *here*) is the rare exception and must be reviewable.

---

## How to add common things

- **A chart:** add an entry to `CHART_SPECS` in `lib/chartSpec.ts`; if it needs new fields, extend
  `MonthRow` + `deriveMonthlySeries` in `lib/series.ts` (with a hand-calc test) — don't compute in
  the component.
- **A stat card / widget:** register it in `lib/widgets/registry.tsx` (+ `statSpec.ts` for a simple
  stat); gate visibility on `isPlaced`.
- **A data source:** capture it in `lib/ngrid/collect.ts` (intercept-and-widen), shape it with a
  **pure** parser in `lib/ngrid/`, add a model + upsert in `lib/ngrid/persist.ts`, surface it via
  `lib/queries.ts` / `lib/series.ts`. If it's a number, add a `verify.ts` cross-check.
- **A scheduler task:** add a `TASK_DEFS` entry in `lib/scheduler/tasks.ts` (portal/order/label/
  cadence/trigger-wording) + a handler in `lib/scheduler/handlers/` exporting a `TaskHandler`. No
  switch statements.
- **An API route:** `app/src/app/api/<name>/route.ts` with `runtime = 'nodejs'` and
  `dynamic = 'force-dynamic'`; return display-ready data (resolve labels/shaping server-side).
- **A setting:** display pref → `lib/prefs.tsx`; server setting → `AppSetting` + `/api/settings`.

## Before you finish

- [ ] Unit tests pass via the **Docker test stage** (paste the summary).
- [ ] For any numeric change, `GET /api/verify` is green on a real account (paste the summary).
- [ ] New pure logic has a hand-calculated test and lives in a pure module, not a component/route.
- [ ] No secret or personal data is staged (`.env`, `data/`, session, PDFs, account #, address).
- [ ] Style matches the surrounding code; no unjustified new dependency; no masked check.
