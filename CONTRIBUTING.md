# Contributing to Ember

Thanks for helping out. This is a self-hosted dashboard that scrapes your **National Grid**
account and charts usage, costs (supply vs delivery), effective rates, and weather-normalized
usage. For *running* the app, see the [README](README.md); this guide is for **contributors**.

## Read this first — the three golden rules

1. **The bill PDF is the source of truth, not the API.** Several API fields are *plausible but
   wrong* for analysis ([Data Accuracy](https://github.com/delabrcd/ember/wiki/Data-Accuracy)). Any change that touches
   a number must keep the cross-validation green and be backed by hand-calculated tests.
2. **Number logic lives in pure, tested functions** — `parsePdf.ts` / `series.ts` /
   `prediction.ts` — so it's unit-testable without a browser or DB. Don't bury arithmetic in a
   React component or an API route.
3. **Be a good guest.** The scraper hits a third party with a real account. Reuse the session,
   rate-limit, and never add aggressive polling. Personal use only.

## In-repo docs

- **[docs/standards.md](docs/standards.md)** — the binding engineering rules every change must
  satisfy (the full, enforceable version of the three golden rules above).
- **[docs/architecture.md](docs/architecture.md)** — how the system is shaped and where things live.

## Documentation — the [project wiki](https://github.com/delabrcd/ember/wiki)

| Page | What |
|---|---|
| [Architecture](https://github.com/delabrcd/ember/wiki/Architecture) | Components, data flow, modules, data model. |
| [Development Setup](https://github.com/delabrcd/ember/wiki/Development-Setup) | Run it locally, env vars, hit the DB, debug a scrape. |
| [How the Scraper Works](https://github.com/delabrcd/ember/wiki/How-the-Scraper-Works) | B2C login, the "intercept-and-widen" technique, endpoints, PDFs. |
| [Data Accuracy](https://github.com/delabrcd/ember/wiki/Data-Accuracy) | **The requirements that matter most** — why we trust PDFs and what every numeric change must satisfy. |
| [Testing](https://github.com/delabrcd/ember/wiki/Testing) | Hand-calculated unit tests + real-data cross-validation. |
| [Releases and CI](https://github.com/delabrcd/ember/wiki/Releases-and-CI) | Image tags, release-driven publishing, versioning. |

## Workflow

1. Fork (or branch off `main`).
2. Make your change. Keep number logic pure + tested
   ([Data Accuracy](https://github.com/delabrcd/ember/wiki/Data-Accuracy), [Testing](https://github.com/delabrcd/ember/wiki/Testing)).
3. Build and run it: `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.
4. Run the tests and (for numeric changes) the cross-validation.
5. Open a PR against `main` with a clear description and the checklist below.

## PR checklist

- [ ] `docker run --rm ember-test` passes (see [Testing](https://github.com/delabrcd/ember/wiki/Testing)).
- [ ] For anything touching numbers: `GET /api/verify` is green on a real account — summary pasted in the PR.
- [ ] New pure logic (parsing/math/prediction) has a hand-calculated unit test.
- [ ] No secrets or personal data committed (`.env`, `data/`, session, PDFs, account numbers, addresses). They're gitignored — keep it that way.
- [ ] New numeric/parse logic lives in `parsePdf.ts` / `series.ts` / `prediction.ts`, not in a component or route.
- [ ] Code matches the surrounding style (TypeScript, existing naming/idioms); no new dependency without a reason.
- [ ] If the portal interaction changed, you verified a real scrape end-to-end.

## Coding conventions

- **TypeScript throughout**; keep the strict-mode build clean.
- **Pure where it counts.** Anything you'd want to unit-test (math, parsing, prediction) is a
  pure function with no DB/browser/React dependency.
- **Charts are declarative.** Add or change a chart by editing `lib/chartSpec.ts`; the generic
  `ConfigurableChart` renders it and derives its config menu. Don't fork a bespoke chart.
- **Prefs vs settings.** Display prefs → `lib/prefs.tsx` (localStorage); runtime app settings
  (e.g. the scheduler toggle) → the `AppSetting` table + `/api/settings`.
- **Match the repo** — comment density, naming, and structure should look like the file you're in.

## Security & secrets

- Credentials are read from **env at runtime** (`NGRID_USER`/`NGRID_PASS`) — never hardcode or
  commit them. The saved session lives in a root-only Docker volume (`0600`); don't relocate it
  to a bind mount or log its contents.
- `.gitignore` excludes `.env` and `data/`. Before committing, double-check nothing under those
  (PDFs, session, DB) and no account number / address / domain slipped into source.
- **No app-level auth by design.** The dashboard exposes financial data and is meant to be
  LAN-only or behind a reverse proxy / SSO. Don't add a public login or instructions to expose it.

## Etiquette & Terms of Service

This scraper accesses a **third-party site with a real account**. Automated access may be against
National Grid's ToS — it's personal-use, at-your-own-risk. Contributions must keep it gentle:
**reuse the session**, keep the rate-limit/jitter, and never add tight polling or parallel
logins. If you touch the scheduler, preserve the "tighten near the predicted bill, back off
otherwise" behavior.

## Commits

- Write clear, imperative commit messages.
- Author commits as **yourself**. This repo keeps AI/co-author trailers off — don't add
  `Co-Authored-By` trailers.

## How to add common things

- **A chart:** add an entry to `CHART_SPECS` in `lib/chartSpec.ts`; extend `MonthRow` +
  `deriveMonthlySeries` if it needs new fields (with a test).
- **A data source:** capture it in `collect.ts` (intercept-and-widen), normalize it, add a model
  + upsert in `persist.ts`, surface it via `queries.ts`/`series.ts`. If it's a number, add a
  `verify.ts` cross-check.
- **An API route:** `app/src/app/api/<name>/route.ts` with `runtime = 'nodejs'` and
  `dynamic = 'force-dynamic'`.
- **A setting:** display pref → `prefs.tsx`; server setting → `AppSetting` + `/api/settings`.
