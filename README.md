# National Grid Dashboard

[![Release](https://img.shields.io/github/v/release/delabrcd/ngrid-dashboard?sort=semver)](https://github.com/delabrcd/ngrid-dashboard/releases/latest)
[![Build and publish image](https://github.com/delabrcd/ngrid-dashboard/actions/workflows/docker-publish.yml/badge.svg)](https://github.com/delabrcd/ngrid-dashboard/actions/workflows/docker-publish.yml)
[![License: MIT](https://img.shields.io/github/license/delabrcd/ngrid-dashboard)](LICENSE)
[![GHCR image](https://img.shields.io/badge/ghcr.io-delabrcd%2Fngrid--dashboard-2496ED?logo=docker&logoColor=white)](https://github.com/delabrcd/ngrid-dashboard/pkgs/container/ngrid-dashboard)

A self-hosted dashboard for your **National Grid (US)** electricity & gas account.
It logs into `myaccount.nationalgrid.com`, pulls your **entire** bill + usage history,
stores it in Postgres, and gives you charts of usage, cost (supply vs delivery),
effective **rates** ($/kWh, $/therm), and a usage-vs-weather view — plus every bill
PDF. It re-checks automatically as your next bill approaches, and has a manual
**"Check for new bills"** button.

> Works for any National Grid US region (Upstate NY, Metro NY, MA, RI) — your region
> and company code are detected automatically from your account.

![The dashboard: a responsive single-screen cockpit with stat cards, a next-bill cost estimate, a month/year range picker, and paginated usage / cost / rates / weather charts](docs/dashboard.png)

## Features

- **Full history, automatically.** Logs in once, reuses the session, and pulls your
  **entire** bill + usage history and every bill PDF — then keeps itself current.
- **Cost done right.** Supply vs delivery, effective **rates** ($/kWh, $/therm), and a
  trailing-12-month all-in average — all sourced from the bill **PDF's Total Current
  Charges**, not the API's (carryover-inflated) Amount Due.
- **Weather & degree-days.** Full bill-history temperatures from **Open-Meteo** (monthly +
  daily), geocoded from your service address, with **heating/cooling degree-days (HDD/CDD)**
  and **weather-normalized** usage so a cold snap doesn't look like waste.
- **Next-bill estimate.** Projects your next bill's **cost** from recent usage × current
  rates, with a confidence band. It's an estimate — never stored, never feeds verification.
- **Multiple accounts.** Discovers every billing account behind a login and gives you a
  **switcher**; charts and exports follow the selected account.
- **Encrypted credential store.** Save National Grid logins **AES-256-GCM-encrypted at rest**
  (key from `NGRID_SECRET_KEY`, or auto-generated and persisted on first run). **Interactive
  MFA/OTP** login + re-authentication, safe removal (keep or delete that account's data, with
  a password confirm), and a `needs_reauth` status when a session goes stale. Env creds remain
  the bootstrap/fallback; a password is never logged or returned to the browser.
- **Export & download.** **CSV export** of the series and bills, and **bulk PDF download** of
  any bill date range as a **zip** (Windows/macOS) or **tgz** (Linux).
- **New-bill notifications.** Off by default; on a *scheduled* check that finds a new bill,
  fire exactly one notification via **webhook / ntfy / SMTP**.
- **Gentle scheduler.** Polls only **near the predicted bill date** (predicted ± a window
  sized from your historical bill spacing), idle otherwise — easy on National Grid.
- **Cockpit UI.** A responsive single-screen layout (no page scroll on a 16:9 desktop,
  collapses to mobile), **paginated chart panels**, a **visual month/year range picker** with
  presets driving every view, per-chart customization, a **live scrape-progress** banner, and
  the running app **version** in the header + Settings.
- **Safe upgrades.** A **pre-upgrade `pg_dump` backup** (fail-closed) before any
  schema-changing deploy, plus CI that gates every merge on the unit tests **and** a
  migration-safety job proving an upgrade preserves seeded data.

## Quick start (Docker)

You need Docker + the Docker Compose plugin. **No clone or build required** — just grab
two files (the compose file pulls the prebuilt image from GHCR):

```bash
mkdir ngrid-dashboard && cd ngrid-dashboard
curl -fsSLO https://raw.githubusercontent.com/delabrcd/ngrid-dashboard/main/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/delabrcd/ngrid-dashboard/main/.env.example -o .env
# edit .env: set NGRID_USER / NGRID_PASS (your National Grid login) and a DB_PASSWORD
nano .env
docker compose up -d
```

(Or download `docker-compose.yml` + `.env.example` from the
[latest release](https://github.com/delabrcd/ngrid-dashboard/releases/latest).)

Open **http://localhost:3000** and click **Check for new bills**. Update later with
`docker compose pull && docker compose up -d`.

**Building from source instead** (developers): clone the repo, then
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build`.

### Image tags

The image is published to **`ghcr.io/delabrcd/ngrid-dashboard`** by CI:

| Tag | Points at |
|---|---|
| `latest` | the newest tagged release (what `docker compose` pulls by default) |
| `X.Y.Z`, `X.Y`, `X` | a specific [semver](https://semver.org) release (e.g. `0.1.0`, `0.1`, `0`) |
| `edge` | the current `main` branch |
| `sha-xxxxxxx` | the exact commit of any build |

Pin a release for reproducibility by setting `image: ghcr.io/delabrcd/ngrid-dashboard:0.1.0`
in your compose file.

**Cutting a release = publishing a GitHub Release.** The release creates the tag and drives
the build; the version is derived from the release tag (no manual `package.json` bump):

```bash
gh release create v0.1.1 --generate-notes
```

(or GitHub UI → Releases → *Draft a new release* → choose a new tag `vX.Y.Z` → *Publish*).
CI then publishes `0.1.1`/`0.1`/`0` and moves `:latest`. (Each release is also gated on the
unit tests and a migration-safety check — see [Accuracy & tests](#accuracy--tests).) The app
shows the running version in its header and Settings (`vX.Y.Z` for releases,
`0.0.0-edge.<sha>` for `main`/`edge` builds). The first run logs
in, downloads your whole history and every PDF (a couple of minutes), then the charts
fill in. After that it keeps itself up to date automatically.

### Configuration (`.env`)

Only the National Grid login and DB password are required; everything below them is optional
(sensible defaults, or a feature stays off until configured). Full reference + comments live in
[`.env.example`](.env.example).

| Var | What |
|---|---|
| `NGRID_USER` / `NGRID_PASS` | Your National Grid account email + password. These are the **bootstrap/fallback** login — once you save a login in the UI (encrypted), the stored one is used. |
| `DB_PASSWORD` | Any long random string (used for the bundled Postgres) |
| `DATABASE_URL` | Pre-filled to point at the `ngrid_postgres` container — change the password to match `DB_PASSWORD` |
| `APP_PORT` | Host port for the UI (default 3000) |
| `TZ` | Your timezone, e.g. `America/New_York` |
| `PDF_DIR` | Host path for bill PDFs (default `./data/pdfs`) |
| `SCHEDULER_ENABLED` | `false` to disable automatic checking (manual button only); also toggleable in Settings |
| `NGRID_SECRET_KEY` | Key for the **encrypted credential store** (AES-256-GCM). `openssl rand -base64 32`. Optional — if unset, one is auto-generated and persisted under the session volume. The key is **never** stored in the DB. |
| `NOTIFY_CHANNEL` + channel vars | New-bill notifications (off by default): `webhook` (`NOTIFY_WEBHOOK_URL`), `ntfy` (`NTFY_URL`/`NTFY_TOPIC`/`NTFY_TOKEN`), or `smtp` (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`/`SMTP_TO`). Leave `NOTIFY_CHANNEL` unset to infer from whichever block you fill in. |
| `APP_BASE_URL` | Public URL of this dashboard, used to build the link in a notification |
| `BACKUP_DIR` / `BACKUP_BEFORE_MIGRATE` / `BACKUP_RETENTION` | Pre-upgrade DB backups (default `./data/backups`, on, keep newest 10) — see [Data & volumes](#data--volumes) |

## How it works

- **Scraper** (`app/src/lib/ngrid/`) drives a headless Chromium (bundled in the
  image). It logs in through National Grid's Azure AD B2C flow once, then **reuses the
  session** so it rarely needs to log in again. It reads your data by intercepting the
  portal's *own* API calls and widening their date filters — so it stays aligned with
  whatever the site returns and keeps the site's auth intact. A login can fan out to
  **multiple billing accounts**; each is scraped and selectable in the UI.
- **Login store**: National Grid logins are saved **AES-256-GCM-encrypted** in the DB
  (`NgLogin`), with **interactive MFA/OTP** when a login needs it. Env creds are the
  bootstrap/fallback when no stored login exists.
- **Database**: Postgres, schema in `app/prisma/schema.prisma`. On startup the app syncs the
  schema (`prisma db push`); before any schema-changing upgrade it takes a fail-closed
  `pg_dump` backup first.
- **Weather**: full bill-history temperatures from **Open-Meteo** (monthly + daily),
  geocoded from your service address, used for the weather charts and **degree-day**
  (HDD/CDD) weather-normalization.
- **Scheduler**: predicts your next statement date from the spacing of past bills and only
  checks **near that date** (predicted ± a window sized from your historical bill spacing),
  staying idle otherwise. Can optionally **notify** you (webhook / ntfy / SMTP) when a
  scheduled check finds a new bill.
- **Dashboard**: Next.js + Recharts — a responsive single-screen cockpit with a month/year
  range picker, paginated chart panels, CSV export, bulk-PDF download, and a next-bill cost
  estimate.

## Accuracy & tests

The numbers are validated two ways, because an API value can be plausible but wrong:

- **Hand-calculated unit tests** (`app/test/`, [vitest](https://vitest.dev)) cover the PDF
  charge parser, the rate math (supply / all-in / 12-month average), and bill-date
  prediction with values worked out by hand. **CI runs them on every PR/push and gates the
  image build on them** (plus a migration-safety job that proves a schema upgrade preserves
  data on a seeded copy of the previous release). Run them yourself:
  ```bash
  docker build --target test -t ngrid-test ./app && docker run --rm ngrid-test
  ```
- **Cross-validation against the actual bills.** The bill PDF is the source of truth, so
  `GET /api/verify` (or **Settings → Verify all bills**) re-parses every PDF and asserts
  the stored/API numbers match it: bill total, kWh/therms usage, and the supply/delivery
  breakdown, plus internal consistency (supply + delivery + other = current charges) and
  that the statement *Amount Due* = current charges + any carried-over balance.

  This caught a real issue: the API's bill `totalDueAmount` is the statement **Amount
  Due** (which can include a carried-over balance or late fees), *not* the period's
  energy cost. The dashboard uses the PDF's **Total Current Charges** for all cost and
  rate analysis so carryovers don't distort your numbers.

## Security & etiquette — please read

- **There is no built-in login.** The dashboard shows your financial data to anyone who
  can reach the port. Keep it on your LAN, or put it behind a reverse proxy / VPN /
  SSO. **Do not expose port 3000 to the public internet.**
- Your credentials live in `.env` — keep it private (`chmod 600 .env`). If you save a login
  through the UI instead, the password is **encrypted at rest (AES-256-GCM)** in the DB; the
  key (from `NGRID_SECRET_KEY`, or auto-generated) lives only in the session volume, never in
  the DB, and a decrypted password is never logged or returned to the browser.
- The in-app login-management UI is **not** a public auth layer — it inherits the same access
  gate (LAN / reverse proxy / SSO) and must never expose financial data un-gated.
- The saved Playwright login **session** (live auth tokens) lives in a root-only Docker volume
  (`0600`), not in your working directory.
- This automates access to **your own account** for personal use. Be gentle: the app
  reuses its session and rate-limits checks to avoid hammering National Grid. Automated
  access may be against National Grid's Terms of Service — use at your own risk.
- **MFA/OTP** is supported **interactively** when you set up or re-authenticate a login in the
  UI. The **unattended scheduler** can't answer an OTP prompt, so a login that always demands
  MFA can't be auto-refreshed (it surfaces a clear status).

## Data & volumes

- **Postgres** → Docker named volume `pgdata` (managed by Docker; no host-permission
  surprises). Back up with `docker compose exec ngrid_postgres pg_dump -U ngrid ngrid > backup.sql`.
- **Login session + secret key** → Docker named volume `session` (sensitive: holds live auth
  tokens, so it's kept in a root-only volume, `0600`, out of your working directory — not a
  bind mount). If you don't set `NGRID_SECRET_KEY`, the auto-generated credential-store key is
  persisted here too (`session/secret.key`, `0600`) — keep this volume to keep your stored
  logins decryptable.
- **Bill PDFs** → a host directory, `./data/pdfs/<account>/<date>.pdf` by default; point
  `PDF_DIR` at any path (e.g. a NAS) in `.env`.
- **Pre-upgrade DB backups** → a host directory, `./data/backups` by default (`BACKUP_DIR`).
  Before applying a schema-changing upgrade, the app `pg_dump`s the database here (one
  gzipped dump per upgrade, newest `BACKUP_RETENTION` kept) so there's always a restore
  point — and it refuses to apply the change if that backup can't be written. Restore one
  with:
  ```bash
  gunzip -c ./data/backups/ngrid-pre-migrate-<stamp>.sql.gz \
    | docker compose exec -T ngrid_postgres psql -U ngrid -d ngrid
  ```

To get PDFs out of the container if you change the mount: `docker compose cp ngrid_dashboard:/data/pdfs ./pdfs`.

To wipe everything and start over: `docker compose down -v` (removes the named volumes), then
delete your PDF directory.

## License / disclaimer

[MIT](LICENSE). Personal project — not affiliated with, endorsed by, or supported by
National Grid.
