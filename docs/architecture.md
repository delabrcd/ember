# Architecture

How Ember is shaped and where things live. Read this with [standards.md](standards.md) — that doc
says *what rules a change must satisfy*; this one is the *map*. For the deep dives on individual
subsystems see the design docs in this folder ([scheduler-v2-plan.md](scheduler-v2-plan.md),
[rfc-ui-widget-architecture.md](rfc-ui-widget-architecture.md)) and the
[wiki](https://github.com/delabrcd/ember/wiki).

---

## 1. What it is

A self-hosted **Next.js 14 (App Router, standalone) + Postgres 16 + in-process Playwright** app that
scrapes a **National Grid** account and charts usage, cost (supply vs delivery), effective rates, and
weather-normalized usage. Single-operator, self-hostable, region-portable. **No app-level auth by
design** — LAN-only or behind a reverse proxy / SSO.

The whole app is one container image (`ghcr.io/delabrcd/ember`) built on the official Playwright base
(`mcr.microsoft.com/playwright`) so Chromium + its OS deps are present for the scraper. `pdftotext`
(poppler-utils) and `pg_dump`/`psql` (postgresql-client) are layered in for PDF parsing and the
pre-migrate backup.

## 2. Deployment & the image

Ember ships as a **single self-contained image** (`ghcr.io/delabrcd/ember`) plus a Postgres 16
database — bring your own `docker-compose.yml` (a reference compose lives at the repo root). It is
meant to run **behind a reverse proxy / SSO** with no app-level auth (see §1). Recommended layout:

- **Persist** `/data` (saved Playwright session + the auto-generated `secret.key`, bill PDFs,
  backups) and the Postgres datadir on the host.
- **Provide** `DATABASE_URL`, the National Grid credentials (`NGRID_USER`/`NGRID_PASS`, or manage
  them in-app), and optionally `NGRID_SECRET_KEY`. See `.env.example` for the full list.
- For a **non-production copy**, run with the **scheduler disabled** (`SCHEDULER_ENABLED=false`) and
  placeholder credentials — never point a second environment at the live portal (standards §4).

Image tags (set by CI, §7): a GitHub Release publishes `X.Y.Z` + moves **`:latest`**; a push to
`main` publishes **`:edge`**. Pin `:latest` for stability or track `:edge` for the bleeding edge.

The container runs **non-root** (user `ember`, uid 1002) and is **arbitrary-uid-tolerant** — you can
override the uid/gid at runtime (e.g. `user: "1000:1000"` to match a host user for bind-mount access)
and it still boots. Runtime-writable paths (`/data`, `/app/.next/cache`, `/etc/passwd`) are group-0 +
other-writable, and the entrypoint self-registers an `/etc/passwd` line for the running uid so
`getpwuid()` resolves for `psql`/Chromium. See `app/Dockerfile` and `app/docker-entrypoint.sh`.

## 3. Runtime shape

```
docker-entrypoint.sh
  ├─ (schema-changing?) backup_before_migrate()  → ngrid-pre-migrate-*.sql.gz  [fail-closed]
  ├─ prisma db push --accept-data-loss           → apply schema (no migration files)
  ├─ next start                                  → the app on :3000
  └─ lightweight cron loop ──POST──▶ /api/cron/tick   (every N minutes; no in-process daemon)
                                          │
                                          ▼
                                   scheduler.tickOnce() → runTick('SCHEDULED')
```

There is **no Node-level cron** — instead a background shell loop in the entrypoint pokes
`/api/cron/tick`, which keeps the trigger reliable on the Node runtime and the build edge-safe. (It is
still an in-process background loop, just in bash; if that subshell dies, scraping stops silently
until the container restarts — monitor liveness externally.) A manual "Check for new bills" button
hits `POST /api/refresh`, which enters the same runner with `trigger='MANUAL'`. Single-flight (never
two concurrent National Grid logins) is enforced in two layers in `lib/scheduler/progress.ts`: an
**in-memory** lock is the fast path for the common single-process case, backed by a **cross-process
claim** so concurrent ticks across processes/replicas degrade safely (the second backs off with
`ScrapeBusyError`). The claim takes a Postgres **transaction-scoped advisory lock** to serialize
concurrent claimers, then a pure decision (`scrapeLock.ts`) treats the most-recent `ScrapeRun
status=RUNNING` row as the durable cross-process flag: a fresh RUNNING run ⇒ BUSY, no RUNNING row ⇒
CLAIM. A run that crashed mid-scrape (its row never finalized) goes **stale** after
`SCRAPE_STALE_AFTER_MS` (~6 min, above the 300s route maxDuration) and stops blocking, so the guard
can't deadlock future ticks. Single-replica is still the recommended deployment, but a stray second
worker no longer logs in twice.

## 4. Pure core vs impure shell

The dominant pattern: **pure, hermetic, unit-tested logic** is separated from **I/O-bearing shells**.
Pure modules may import Prisma *types* (`import type`) but never the client, Playwright, or fetch.

A worked example — the monthly series:

```
/api/series (route, IMPURE)         lib/series.ts (PURE)
  ├─ prisma.usage.findMany()  ─┐
  ├─ prisma.cost.findMany()    ├─▶ deriveMonthlySeries(input: SeriesInput): MonthRow[]
  ├─ prisma.weather…           │     (rates, normalized usage, YoY, projection — all pure math)
  └─ gather → SeriesInput  ────┘        │
                                        ▼
                              NextResponse.json({ rows })   ← tested as JSON shape
```

`deriveMonthlySeries` is hand-calc tested (`test/series.test.ts`) with zero infra. The same shape
recurs in the scheduler (pure `cadence`/`projection` vs impure `handlers`), weather (pure
`degreeDays` vs impure `weatherSync`), and crypto (pure `crypto.ts` given a key vs impure
`secretKey.ts` that resolves the key). The ~45 files in `app/test/` are almost all this pure layer.

## 5. Module map (`app/src/`)

### `lib/ngrid/` — the scraper
B2C login, multi-account discovery, intercept-and-widen GraphQL, PDF parsing, cross-validation.

- **Login/session:** `session.ts` (the `PortalSession` Playwright lifecycle), `auth.ts`,
  `bootstrap.ts` (env-cred fallback), `preflight.ts` / `preflightState.ts` (user/pass+OTP check),
  `loginStatus.ts`, `secretKey.ts` (key resolution).
- **Collection (impure):** `collect.ts` (orchestrates a headless browse, accepts an optional shared
  `session`), `portalFetch.ts` (PDF download + AMI interval fetch, incl. page-until-dry backfill),
  `discoverInterval.ts` (does the account have an AMI smart meter?), `firstRun.ts`.
- **Pure parsers:** `parsePdf.ts` (PDF text → `BillDetail`), `interval.ts` (interval row shaping +
  `backwardChunks` paging helper), `accounts.ts`.
- **Persist/verify (impure):** `persist.ts` (guarded upserts — fill-only conditional for AMI zeros),
  `verify.ts` (re-parse + cross-check feeding `/api/verify`).

Key data facts: the PDF is the source of truth (`currentCharges`, not `totalDueAmount`); interval
grains coexist (`intervalSeconds` ∈ {900 = 15-min, 3600 = hourly, 86400 = daily}); **15-min electric
is NRT-only (the REST endpoint rejects start > 48h ago)** so it is captured forward, not
back-scraped, while deep history is hourly GraphQL.

### `lib/scheduler/` — Scheduler V2 (generic task-runner)
Replaced the old scrape-specific monolith. A single flag-free path runs any due `ScheduledTask`.

- **`types.ts`** — `TaskKind` union, `TaskContext`, `TaskHandler`, `TaskResult`, `TaskMetrics`
  (types only; `import type` for `PortalSession`/`ProgressFn` keeps it hermetic).
- **`tasks.ts`** — `TASK_DEFS: Record<TaskKind, TaskDef>`, the **pure descriptor registry**. One
  entry per kind co-locates `portal`, `order`, `label`, `cadence(now, facts)`, and the human
  `inactiveReason`/`collapsedReason` wording. **This is the modularity contract: no switch statements
  on `TaskKind` anywhere.** Adding a task = a `TASK_DEFS` entry + a handler.
- **`cadence.ts`** (pure) — per-task next-run math (`computeFullScrapeNextRun`,
  `computeIntervalNextRun`, `computePdfFetchNextRun`).
- **`projection.ts`** (pure) — the 7-day "upcoming actions" simulator; walks each task's `cadence` from
  a virtual clock. Feeds `/api/schedule/upcoming`.
- **`runner.ts`** (impure) — `runTick(trigger)` / `runManual()`: load due tasks, **group portal tasks
  by login and share one `PortalSession`** (one login per tick), dispatch via `HANDLERS`, fold
  `TaskMetrics` into the `ScrapeRun` summary, arm follow-up tasks.
- **`runnerHelpers.ts`** (pure), **`seed.ts`** (pure planner + impure seeder), **`progress.ts`**.
- **`handlers/`** (impure) — `fullScrape` (arms `pdf-fetch`/`weather-sync`/`notify-sync`),
  `intervalPull`, `pdfFetch`, `weatherSync`, `notifySync`, and `index.ts` (the `HANDLERS` map).

The five tasks: `full-scrape` (portal, order 0), `interval-pull` (portal, 1), `pdf-fetch` (portal,
2), `weather-sync` (non-portal, 10), `notify-sync` (non-portal, 11). `weather-sync`/`notify-sync` are
**reactive** (`cadence: () => null`) — armed by `full-scrape`, not periodic. `notify-sync` arms only
on `SCHEDULED` so a manual refresh stays silent. See [scheduler-v2-plan.md](scheduler-v2-plan.md).

### Pure number / shaping libs
`series.ts` (monthly aggregation, rates, YoY, projection), `prediction.ts` (next-bill Kalman model +
12-month projection), `ym.ts` / `range.ts` (month arithmetic), `format.ts`, `emissions.ts`,
`anomaly.ts` + `notifications.ts` + `notifyFormat.ts` (pure decisioning; `notify.ts` /
`notificationStore.ts` send + persist), `weather/*` (degree-days, normals), `viz/*` (aggregation,
`downsampleInterval.ts`), `intervalProfile.ts` / `intervalHistory.ts`, `billRecap.ts`, `csv.ts`,
`comparePresets.ts`, `accountSwitcher.ts`, `layoutEngine.ts` / `cockpit.ts` (grid/pref merging).

### Crypto & secrets
`lib/crypto.ts` (AES-256-GCM, pure given a key) + `lib/ngrid/secretKey.ts` (impure key resolution:
`NGRID_SECRET_KEY` env → persisted `/data/session/secret.key` → generate). See standards §3.

### `app/src/app/api/` — the API surface
Notable routes (all `runtime='nodejs'`, `dynamic='force-dynamic'`):

| Route | Purpose |
|---|---|
| `POST /api/cron/tick` | scheduler heartbeat (entrypoint loop) → `runTick('SCHEDULED')` |
| `POST /api/refresh` · `GET /api/refresh/[id]` | manual scrape (`trigger='MANUAL'`) + poll `ScrapeRun` |
| `GET /api/verify` | re-parse PDFs, cross-check vs API — the data-accuracy gate (single-account: checks the lowest-id account only) |
| `GET /api/series` | `MonthRow[]` via `deriveMonthlySeries` |
| `GET /api/overview` | dashboard stat-card aggregates (also the smoke-boot health probe) |
| `GET /api/interval` | windowed interval usage, server-downsampled to ≤ ~600 points |
| `GET /api/schedule/upcoming` | display-ready 7-day projection `{ at, label, detail }` |
| `GET /api/bills` · `GET /api/bills/[date]/pdf` | bills list + PDF stream |
| `GET/POST /api/settings` | runtime `AppSetting` CRUD |
| `…/api/ng-logins/**` | stored-credential management + preflight/OTP (never returns plaintext) |
| `GET /api/backup` | streams a tar.gz of `pg_dump` + PDFs + manifest |
| `GET/PATCH /api/dashboard/layout` | server-persisted widget layout |

### `app/src/components/` — the UI
`Dashboard.tsx` is the shell (data via `useDashboardData`, layout via `useDashboardLayout`, scoped by
`AccountSwitcher` + the global `RangeControl`). Charts are **declarative**: `ConfigurableChart` +
`ChartShell` render any `ChartSpec` from `lib/chartSpec.ts` (`CHART_SPECS`) — config menu, axis
formatters, scale/stack toggles all derived from the spec. Widgets register in
`lib/widgets/registry.tsx` and are placed on a React-Grid-Layout grid, gated on `isPlaced`.
`SettingsView.tsx` is the tabbed settings page (it reads `/api/schedule/upcoming` for the
upcoming-actions table — it has **zero** knowledge of task internals). Interval widgets follow the
global range selector.

## 6. Data model (`app/prisma/schema.prisma`)

Applied at boot via `prisma db push` — **there are no migration files**; the schema *is* the source
of truth. Additive only; data tables are append-only (standards §6).

- **`NgLogin`** — stored credentials; `ciphertext`/`iv`/`authTag` (AES-256-GCM). One login → many
  accounts.
- **`Account`** — `accountNumber` (unique), `loginId` FK, region/company, lat/lon, fuel types.
- **`Bill`** — `@@unique([accountId, statementDate])`; `currentCharges` is canonical, `pdfPath`.
- **`Usage`**, **`Cost`** — per-period usage / supply+delivery costs, unique per
  account+type+period.
- **`IntervalUsage`** — `@@unique([accountId, fuelType, intervalStart, intervalSeconds])`; UTC start +
  grain seconds; coexisting 15-min/hourly/daily grains; append-only (~0.1 GB/decade).
- **`Weather`**, **`WeatherDaily`** — monthly + daily temps for degree-day normalization.
- **`ScrapeRun`** — per-tick run record (`trigger`, `status`, `billsAdded`, message).
- **`ScheduledTask`** — `@@unique([kind, accountId])`, `payload Json`, `nextRunAt`, `enabled`; the V2
  scheduler's durable state, `onDelete: Cascade` from `Account`.
- **`ScheduleState`** — per-account predicted next bill + `nextCheckAt`.
- **`Notification`** — new-bill / anomaly log, deduped by `key`.
- **`AppSetting`** — key/value runtime settings (the one non-additive, mutable table).

## 7. CI/CD pipeline (`.github/workflows/docker-publish.yml`)

Publish (`build-push`) is gated on **five jobs**, all of which run on every PR + push:

1. **`test`** — the Docker `test` stage (`docker build --target test` → `docker run`): hermetic
   vitest. The *real* test path.
2. **`lint`** — ESLint (`next/core-web-vitals`, findings as inline annotations) + `tsc --noEmit`.
3. **`migration-safety`** — seeds the **previous release's** schema, applies the current one, proves
   data survives (`db push --accept-data-loss` is irreversible on prod).
4. **`smoke-boot`** — boots the shipped runner image against throwaway Postgres, seeds, asserts
   `/api/overview` serves real data.
5. **`entrypoint-backup`** — exercises the real `backup_before_migrate()` path (fresh→no-dump,
   populated+delta→one valid dump, special-char password #83 guard, bad-creds→fail-closed #85).

**PRs build nothing** (no secrets, no GHCR push). Tags: a **GitHub Release `vX.Y.Z`** publishes
`X.Y.Z`/`X.Y`/`X` and moves **`:latest`**; a **push to `main`** publishes **`:edge`** only; every
build also gets `:sha-…`. The version is stamped from `git describe` into `package.json` at build.

## 8. Where the design lives

| Subsystem | Doc |
|---|---|
| Scheduler V2 task-runner | [scheduler-v2-plan.md](scheduler-v2-plan.md) |
| Modular UI / widget architecture | [rfc-ui-widget-architecture.md](rfc-ui-widget-architecture.md) |
| Data accuracy, scraper internals, releases | [wiki](https://github.com/delabrcd/ember/wiki) |
| The rules every change must satisfy | [standards.md](standards.md) |
