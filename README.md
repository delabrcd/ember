# National Grid Dashboard

A self-hosted dashboard for your **National Grid (US)** electricity & gas account.
It logs into `myaccount.nationalgrid.com`, pulls your **entire** bill + usage history,
stores it in Postgres, and gives you charts of usage, cost (supply vs delivery),
effective **rates** ($/kWh, $/therm), and a usage-vs-weather view — plus every bill
PDF. It re-checks automatically as your next bill approaches, and has a manual
**"Check for new bills"** button.

> Works for any National Grid US region (Upstate NY, Metro NY, MA, RI) — your region
> and company code are detected automatically from your account.

![sections: usage · cost · rates · weather · bills](docs-screenshot-placeholder)

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
CI then publishes `0.1.1`/`0.1`/`0` and moves `:latest`. The app footer shows the running
version (`vX.Y.Z` for releases, `0.0.0-edge.<sha>` for `main`/`edge` builds). The first run logs
in, downloads your whole history and every PDF (a couple of minutes), then the charts
fill in. After that it keeps itself up to date automatically.

### Configuration (`.env`)

| Var | What |
|---|---|
| `NGRID_USER` / `NGRID_PASS` | Your National Grid account email + password |
| `DB_PASSWORD` | Any long random string (used for the bundled Postgres) |
| `DATABASE_URL` | Pre-filled to point at the `ngrid_postgres` container — change the password to match `DB_PASSWORD` |
| `APP_PORT` | Host port for the UI (default 3000) |
| `TZ` | Your timezone, e.g. `America/New_York` |
| `SCHEDULER_ENABLED` | `false` to disable automatic checking (manual button only) |

## How it works

- **Scraper** (`app/src/lib/ngrid/`) drives a headless Chromium (bundled in the
  image). It logs in through National Grid's Azure AD B2C flow once, then **reuses the
  session** so it rarely needs to log in again. It reads your data by intercepting the
  portal's *own* API calls and widening their date filters — so it stays aligned with
  whatever the site returns and keeps the site's auth intact.
- **Database**: Postgres, schema in `app/prisma/schema.prisma`.
- **Scheduler**: predicts your next statement date from the spacing of past bills and
  tightens from weekly to daily checks as that date approaches, then backs off.
- **Dashboard**: Next.js + Recharts.

## Accuracy & tests

The numbers are validated two ways, because an API value can be plausible but wrong:

- **Hand-calculated unit tests** (`app/test/`, [vitest](https://vitest.dev)) cover the PDF
  charge parser, the rate math (supply / all-in / 12-month average), and bill-date
  prediction with values worked out by hand. Run them:
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
- Your credentials live in `.env` — keep it private (`chmod 600 .env`). The saved login
  session lives in a root-only Docker volume (`0600`), not in your working directory.
- This automates access to **your own account** for personal use. Be gentle: the app
  reuses its session and rate-limits checks to avoid hammering National Grid. Automated
  access may be against National Grid's Terms of Service — use at your own risk.
- Accounts with login MFA/OTP aren't supported by the unattended scraper yet (it will
  fail with a clear message).

## Data & volumes

- **Postgres** → Docker named volume `pgdata` (managed by Docker; no host-permission
  surprises). Back up with `docker compose exec ngrid_postgres pg_dump -U ngrid ngrid > backup.sql`.
- **Login session** → Docker named volume `session` (sensitive: holds live auth tokens, so
  it's kept in a root-only volume, `0600`, out of your working directory — not a bind mount).
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

Personal project. Not affiliated with, endorsed by, or supported by National Grid.
