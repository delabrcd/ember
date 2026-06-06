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
in your compose file. Cutting a release: bump `app/package.json` `version`, then
`git tag vX.Y.Z && git push origin vX.Y.Z` (CI builds and tags the image; create a GitHub
Release from the tag for notes). The first run logs
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
- Your credentials live in `.env` and the saved session lives in `./data/session/` —
  both are git-ignored. Keep them private (`chmod 600 .env`).
- This automates access to **your own account** for personal use. Be gentle: the app
  reuses its session and rate-limits checks to avoid hammering National Grid. Automated
  access may be against National Grid's Terms of Service — use at your own risk.
- Accounts with login MFA/OTP aren't supported by the unattended scraper yet (it will
  fail with a clear message).

## Data & volumes

Everything persists under `./data/` (bind-mounted):
- `data/db/` — Postgres
- `data/pdfs/<account>/<date>.pdf` — bill PDFs
- `data/session/session.json` — saved login session (sensitive)

To wipe and start over: `docker compose down && rm -rf data`.

## License / disclaimer

Personal project. Not affiliated with, endorsed by, or supported by National Grid.
