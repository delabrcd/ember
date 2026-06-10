# AGENTS.md

Guidance for AI agents (Claude Code, Codex, etc.) working in this repo. Humans should read
[CONTRIBUTING.md](CONTRIBUTING.md) and the [wiki](https://github.com/delabrcd/ember/wiki).

## What this is

A self-hosted **Next.js + Postgres + Playwright** app that scrapes a **National Grid** account
and charts usage, cost (supply vs delivery), effective rates, and weather-normalized usage.
Single-operator (multi-account / multi-premise per login), self-hostable, region-portable.
**No app-level auth by design** — it's meant to be LAN-only or behind a reverse proxy / SSO.

## Non-negotiable rules

1. **The bill PDF is the source of truth, not the API.** Some API fields are *plausible but
   wrong* for analysis — e.g. `totalDueAmount` is the statement *Amount Due* (can include a
   carried-over balance), **not** the period's energy cost; use `currentCharges` (parsed from the
   PDF). Any change that touches a number must keep `GET /api/verify` green and ship
   hand-calculated tests.
2. **Keep number logic pure and tested.** Parsing → `app/src/lib/ngrid/parsePdf.ts`;
   aggregation/rates → `app/src/lib/series.ts`; prediction → `app/src/lib/prediction.ts`. Don't
   bury arithmetic in a component or an API route.
3. **Never commit secrets or personal data.** Credentials may be **stored AES-256-GCM-encrypted in
   the DB** (`NgLogin` rows — see `app/src/lib/crypto.ts`); the key is **never in the DB** — it's
   resolved by `app/src/lib/ngrid/secretKey.ts` as `NGRID_SECRET_KEY`, else a persisted
   `/data/session/secret.key` file (auto-generated on first run, so persist `/data` — losing it
   orphans every stored credential). Env creds (`NGRID_USER`/`NGRID_PASS`) remain the
   bootstrap/fallback source. Either way nothing secret hits git: `.env`, `data/`, the saved session,
   bill PDFs, and any account number/address are gitignored — keep it that way, and never log or
   return a decrypted password to the client.
4. **Be a good guest.** The scraper hits a third party with a real account. Reuse the session,
   keep the rate-limiting/jitter, and never add aggressive polling or parallel logins.
5. **Don't add a public app-auth layer** or instructions to expose the app to the internet without
   an auth gate. An in-app **NG-login management UI** (to enter/verify the National Grid credentials
   stored above) is allowed, but it inherits the existing access gate (LAN-only / reverse-proxy /
   SSO) — it is **not** a public application-login layer and must never expose financial data
   un-gated.
6. **Don't hand-edit `app/package.json` `version`** — it's a `0.0.0` placeholder; the real version
   is derived from the git tag at build time.

## Commands (Docker only — no host Node/Postgres/Playwright needed)

```bash
# Build + run from source
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build

# Hand-calculated unit tests
docker build --target test -t ember-test ./app && docker run --rm ember-test

# Cross-validate stored/API numbers against the actual bill PDFs (must be green)
curl -s localhost:3000/api/verify | jq '{ok,total,failed}'

# Trigger a scrape (or use the "Check for new bills" button)
curl -X POST localhost:3000/api/refresh        # then poll /api/refresh/<id>

# DB shell
docker compose exec ngrid_postgres psql -U ngrid -d ngrid
```

## Layout (details in the wiki)

- **Scraper:** `app/src/lib/ngrid/{auth,session,collect,portalFetch,persist,parsePdf,verify}.ts` —
  B2C login + shared `PortalSession`, **intercept-and-widen** GraphQL, PDF parsing, upsert,
  cross-validation.
- **Scheduler (V2):** generic task-runner in `app/src/lib/scheduler/` — a pure per-task registry
  (`tasks.ts` `TASK_DEFS`), `cadence.ts`/`projection.ts` (pure), `runner.ts` + `handlers/*` (impure).
  `app/src/lib/scheduler.ts` is just a shim; the entrypoint's bash loop drives it via
  `/api/cron/tick`. See [docs/architecture.md](docs/architecture.md) + [docs/scheduler-v2-plan.md](docs/scheduler-v2-plan.md).
- **API:** `app/src/app/api/*` · **UI:** `app/src/components/*` · **charts** declared in
  `app/src/lib/chartSpec.ts` and rendered by the generic `ConfigurableChart`.
- **Data model:** `app/prisma/schema.prisma`.

## Conventions

- TypeScript throughout; match the surrounding file's style; no new dependency without a reason.
- Charts are **declarative** (`chartSpec.ts`) — don't fork a bespoke chart component.
- Display prefs → `lib/prefs.tsx` (localStorage); runtime settings → the `AppSetting` table +
  `/api/settings`.
- Commits: author as **yourself**; this repo keeps AI/co-author trailers **off** — do not add a
  `Co-Authored-By` trailer.

## Before you finish

- Unit tests pass; for any numeric change, `/api/verify` is green on a real account (paste the summary).
- Nothing secret or personal is staged.

## More

- **[docs/standards.md](docs/standards.md)** — the binding engineering rules (data-accuracy,
  secrets, good-guest, additive-schema, pure-core, CI). Read this before writing code.
- **[docs/architecture.md](docs/architecture.md)** — the system map (module layout, the pure/impure
  split, scheduler, data model, CI/CD, deploy topology).
- [CONTRIBUTING.md](CONTRIBUTING.md) — workflow + PR checklist.
- [Wiki](https://github.com/delabrcd/ember/wiki) — Architecture, How the Scraper Works,
  **Data Accuracy**, Testing, Releases & CI.
