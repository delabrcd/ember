# Ember — National Grid Dashboard

[![Release](https://img.shields.io/github/v/release/delabrcd/ember?sort=semver)](https://github.com/delabrcd/ember/releases/latest)
[![CI](https://github.com/delabrcd/ember/actions/workflows/docker-publish.yml/badge.svg?branch=main)](https://github.com/delabrcd/ember/actions/workflows/docker-publish.yml)
[![License: MIT](https://img.shields.io/github/license/delabrcd/ember)](LICENSE)
[![GHCR image](https://img.shields.io/badge/ghcr.io-delabrcd%2Fember-2496ED?logo=docker&logoColor=white)](https://github.com/delabrcd/ember/pkgs/container/ember)

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
- **Encrypted credential store.** Save National Grid logins **AES-256-GCM-encrypted at rest**,
  with **interactive MFA/OTP** at setup and safe removal. The encryption key never touches the
  database, and a password is never logged or shown back to the browser.
- **Export & download.** **CSV export** of the series and bills, and **bulk PDF download** of
  any bill date range as a **zip** (Windows/macOS) or **tgz** (Linux).
- **New-bill notifications.** Off by default; on a *scheduled* check that finds a new bill,
  fire exactly one notification via **webhook / ntfy / SMTP**.
- **Gentle scheduler.** Polls only **near the predicted bill date** (predicted ± a window
  sized from your historical bill spacing), idle otherwise — easy on National Grid.
- **Cockpit UI.** A responsive single-screen layout (no page scroll on a 16:9 desktop,
  collapses to mobile), **paginated chart panels**, a **visual month/year range picker** with
  presets driving every view, per-chart customization, and a **live scrape-progress** banner.
- **Tested numbers, safe upgrades.** The cost/rate math ships with hand-calculated tests, and a
  **fail-closed `pg_dump` backup** runs before any schema-changing deploy.

## Quick start (Docker)

You need Docker + the Docker Compose plugin. **No clone or build required** — just grab
two files (the compose file pulls the prebuilt image from GHCR):

```bash
mkdir ember && cd ember
curl -fsSLO https://raw.githubusercontent.com/delabrcd/ember/main/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/delabrcd/ember/main/.env.example -o .env
# edit .env: set a DB_PASSWORD (and the matching password in DATABASE_URL)
nano .env
docker compose up -d
```

(Or download `docker-compose.yml` + `.env.example` from the
[latest release](https://github.com/delabrcd/ember/releases/latest).)

Open **http://localhost:3000** and **add your National Grid login in the browser** —
the first-run setup walks you through it (including the **OTP/MFA** step), stores the
password **encrypted at rest**, and auto-generates the encryption key. No National Grid
credentials in `.env` required. The first run then logs in, downloads your whole history
and every PDF (a couple of minutes), and the charts fill in — after that it keeps itself
up to date automatically.

> **Why a `DB_PASSWORD` is still the one thing you set in `.env`:** Postgres isn't exposed
> to your network, but the app and the database container still have to agree on a password.
> Everything else — your National Grid login and the credential-store key — is handled in the
> browser on first run. A fully `.env`-free quickstart is tracked in
> [issue #56](https://github.com/delabrcd/ember/issues/56).

The image (`ghcr.io/delabrcd/ember`) is built and published by CI; **`:latest` is
what compose pulls by default**. To pin a specific version, see the
[Releases & CI](https://github.com/delabrcd/ember/wiki/Releases-and-CI) wiki page.

### Updating

```bash
docker compose pull && docker compose up -d
```

Your data lives in volumes (see [Your data](#your-data)), so it survives the upgrade. Before
any schema-changing upgrade the app takes a fail-closed `pg_dump` backup first, so there's
always a restore point.

## Configuration (`.env`)

**Only `DB_PASSWORD` (and the matching password in `DATABASE_URL`) is required** — everything
else is optional. Your National Grid login and the encryption key are handled in the browser on
first run (see [Quick start](#quick-start-docker)); set them here only if you want to pre-seed an
unattended install. Full reference + comments live in [`.env.example`](.env.example).

| Var | What |
|---|---|
| `DB_PASSWORD` | **Required.** Any long random string (used for the bundled Postgres). |
| `DATABASE_URL` | **Required.** Pre-filled to point at the `ngrid_postgres` container — change the password to match `DB_PASSWORD`. **Using an external Postgres?** A single `DATABASE_URL` works (URL-encode the password). Setting `DB_USER`/`DB_NAME`/`DB_PASSWORD` (raw password) is **recommended when your password has special characters** — the pre-migrate backup then uses discrete libpq params instead of relying on URL-encoding. Either way the backup **fails closed** (refuses the schema sync) if it can't connect at all. |
| `NGRID_USER` / `NGRID_PASS` | **Optional.** Your National Grid email + password. Leave unset and add the login in the browser instead; set them to **pre-seed/bootstrap** (e.g. unattended installs) — on first start they're imported into the encrypted store, with env as the ongoing fallback. |
| `APP_PORT` | Host port for the UI (default 3000) |
| `TZ` | Your timezone, e.g. `America/New_York` |
| `PDF_DIR` | Host path for bill PDFs (default `./data/pdfs`) |
| `SCHEDULER_ENABLED` | `false` to disable automatic checking (manual button only); also toggleable in Settings |
| `NGRID_SECRET_KEY` | **Optional.** Key for the **encrypted credential store** (AES-256-GCM). Leave unset and one is **auto-generated** and persisted under the session volume on first run; set it (`openssl rand -base64 32`) to **override** the auto-generated key with your own. The key is **never** stored in the DB. |
| `NOTIFY_CHANNEL` + channel vars | New-bill notifications (off by default): `webhook` (`NOTIFY_WEBHOOK_URL`), `ntfy` (`NTFY_URL`/`NTFY_TOPIC`/`NTFY_TOKEN`), or `smtp` (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`/`SMTP_TO`). Leave `NOTIFY_CHANNEL` unset to infer from whichever block you fill in. |
| `APP_BASE_URL` | Public URL of this dashboard, used to build the link in a notification |
| `BACKUP_DIR` / `BACKUP_BEFORE_MIGRATE` / `BACKUP_RETENTION` | Pre-upgrade DB backups (default `./data/backups`, on, keep newest 10) — see [Your data](#your-data) |

## Using it

- **Add your National Grid login.** On first run the UI walks you through entering your email
  and password and answering the **OTP/MFA** challenge. The password is stored
  **encrypted at rest**; you'll re-authenticate the same way if a session ever goes stale (a
  clear `needs re-auth` status tells you when). More:
  [Accounts and Login](https://github.com/delabrcd/ember/wiki/Accounts-and-Login).
- **Multiple accounts.** A single login can cover several billing accounts — the dashboard
  discovers them all and gives you a **switcher** in the header. Every chart and export follows
  the account you've selected.
- **Pick a range.** A **visual month/year range picker** (with presets) drives every chart at
  once. Each chart panel is paginated and individually customizable; your range and display
  prefs are remembered. More:
  [Range and Customization](https://github.com/delabrcd/ember/wiki/Range-and-Customization).
- **Read your cost & usage.** Stat cards summarize the current bill and a next-bill **cost
  estimate**; the charts break out usage, supply vs delivery cost, effective **rates**, and a
  **usage-vs-weather** view with degree-days.
- **Export & download.** **CSV** of the series and bills, and a **bulk PDF download** of any
  date range as a single archive (zip on Windows/macOS, tgz on Linux).
- **Get notified.** Optionally have a *scheduled* check that finds a new bill ping you exactly
  once over **webhook / ntfy / SMTP** (off by default — enable it in `.env`). More:
  [Notifications](https://github.com/delabrcd/ember/wiki/Notifications).
- **Check on demand.** The scheduler runs itself near your predicted bill date, but the
  **"Check for new bills"** button forces a fresh scrape any time, with a live progress banner.

## Security & etiquette — please read

- **There is no built-in login.** The dashboard shows your financial data to anyone who
  can reach the port. Keep it on your LAN, or put it behind a reverse proxy / VPN /
  SSO. **Do not expose port 3000 to the public internet.** The in-app login-management UI is
  **not** a public auth layer — it inherits that same access gate.
- **Your credentials are encrypted at rest.** Logins you add in the UI are stored
  **AES-256-GCM-encrypted** in the DB; the encryption key lives only in the session volume,
  never in the database, and a decrypted password is never logged or returned to the browser.
  If you instead pre-seed credentials in `.env`, keep it private (`chmod 600 .env`). The live
  Playwright login session is kept in a root-only Docker volume (`0600`), out of your working
  directory.
- **Personal use only.** This automates access to **your own account**. Be gentle: the app
  reuses its session and rate-limits checks to avoid hammering National Grid. Automated access
  may be against National Grid's Terms of Service — use at your own risk.

## Your data

- **Postgres** → Docker named volume `pgdata` (managed by Docker; no host-permission
  surprises). Back up with `docker compose exec ngrid_postgres pg_dump -U ngrid ngrid > backup.sql`.
- **Login session + secret key** → Docker named volume `session` (sensitive: holds live auth
  tokens, so it's kept in a root-only volume, `0600`, out of your working directory). If you
  don't set `NGRID_SECRET_KEY`, the auto-generated credential-store key is persisted here too
  (`session/secret.key`, `0600`) — keep this volume to keep your stored logins decryptable.
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

## Backup & restore

For a single, portable snapshot of the whole app — enough to rebuild it on a new host — use the
**full backup**:

- **`GET /api/backup`** (or **Settings → Account & data → Download full backup**) streams a single
  `ember-backup-<date>.tar.gz` containing a `pg_dump` of the database (`db.sql`) **plus every bill
  PDF** (`pdfs/<account>/<file>.pdf`) and a `MANIFEST.txt`. The dump is taken with
  `--clean --if-exists --no-owner --no-privileges`, so it restores cleanly into a fresh, empty
  database regardless of role.
- It is **gated by the same posture as the rest of the app** (LAN-only / reverse-proxy / SSO) —
  there is no separate auth on this endpoint, so **never expose it un-gated**, exactly as with the
  rest of the dashboard.

**`NGRID_SECRET_KEY` is required to restore your saved National Grid logins, and is NOT in the
archive.** The database stores those credentials only as AES-256-GCM **ciphertext**; the key that
decrypts them is the `NGRID_SECRET_KEY` env var (or, if you never set one, the auto-generated
`session/secret.key`). **Back that key up separately** — without the same key, a restored backup
can't decrypt your stored logins (charts, bills, and usage still restore fine; only the saved
NG-login credentials need it).

Restore into a **fresh** stack:

```bash
# 1. Bring up just an empty Postgres for the new stack
docker compose up -d ngrid_postgres

# 2. Restore the database + PDFs from a backup archive
./scripts/restore.sh ember-backup-2026-06-09.tar.gz
#   options: --db-container <name> (default ngrid_postgres), --pdf-dir <path> (default ./data/pdfs)

# 3. Put the SAME NGRID_SECRET_KEY back in .env (from your separate secret backup),
#    then start the app — its entrypoint applies the schema and it comes up populated.
docker compose up -d ngrid-dashboard
```

`scripts/restore.sh` extracts the tarball, loads `db.sql` via
`docker compose exec -T ngrid_postgres psql`, copies the PDFs into your `PDF_DIR`, and prints
`Bill`/`Usage` row counts as a sanity check (a direct-`psql` alternative for an external Postgres is
documented in the script's comments).

## Contributing / development

Building from source, running the tests, the release flow, and how the scraper works all live
in [CONTRIBUTING.md](CONTRIBUTING.md) and the
[project wiki](https://github.com/delabrcd/ember/wiki).

## License / disclaimer

[MIT](LICENSE). Personal project — not affiliated with, endorsed by, or supported by
National Grid.
</content>
</invoke>
