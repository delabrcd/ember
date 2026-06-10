# Scheduler V2 — Generic Task-Runner Refactor (design doc)

**Status:** APPROVED DESIGN, not yet implemented (as of 2026-06-10).
**Owner:** team-lead session. **Rollout:** flag-gated (`SCHEDULER_V2`), staged PRs, land on prod incrementally.
**Why this doc exists:** preserves the converged architecture + the architect's file-level plan across
session compaction. Read this before touching the scheduler.

---

## 0. Context & the converged decision (from the design conversation)

Today's scheduler is scrape-specific: an hourly `docker-entrypoint.sh` curl loop → `POST /api/cron/tick`
→ `tickOnce` (`app/src/lib/scheduler.ts`) → if any `ScheduleState.nextCheckAt <= now`, run ONE monolithic
`runScrape('SCHEDULED')` (`app/src/lib/ngrid/run.ts`) that logs in once, scrapes every account, then runs
weather-sync + notifications inline, then `updateSchedule` recomputes `nextCheckAt` with **two inline
special-case caps** (AMI 22h, PDF-pending 6h). The operator dislikes special cases living in the core flow.

**Converged target architecture (operator-directed):**
- Invert control: the scheduler becomes a **generic, task-agnostic, time-gated task runner**. It knows
  nothing about scrapes — each tick it loads due tasks, dispatches each to a handler by `kind`, and writes
  back whatever `nextRunAt` (or `null` = deactivate) the handler returns. **The task entries drive their
  own cadence; the scheduler has no special cases.**
- **Shared session state, separate callbacks** (operator's framing: "same C++ class, different member
  functions registered as different callbacks"): a `PortalSession` abstraction owns the single reused
  login + browser context + captured auth headers. Portal tasks share ONE session per tick and run
  **sequentially** against it (good-guest: ≤1 login/tick, never parallel logins).
- **Decompose anything cleanly separable into its own task** (operator: "anything that can be cleanly
  split into its own task, should be"):
  - Portal tasks (need the session): `full-scrape`, `pdf-fetch`, `interval-pull`.
  - Non-portal tasks: `weather-sync`, `notify-sync`.
- The motivating live problem: a new bill's statement row publishes ~1–3 days **before** NG publishes the
  downloadable PDF, so the bill-prediction back-off would idle ~a week without the PDF. `pdf-fetch` as its
  own short-cadence, self-deactivating task solves this cleanly (and reuses the saved session cheaply
  rather than a fresh login).
- Also wanted: a **"view upcoming scheduler actions for the next 7 days"** surface — falls out of a pure
  per-task simulator that reuses the cadence functions.

Binding constraints (AGENTS.md): bill PDF is source of truth; pure number/decision logic in `lib/` +
unit-tested; never log/return secrets; **be a good guest** (reuse session, keep jitter, no parallel logins
/ aggressive polling); no public app-auth; no unjustified deps. **No-rollback prod** → additive,
non-destructive schema only; existing `migration-safety` CI gate must stay green.

---

## 1. Current-flow map (file:line)

- `app/docker-entrypoint.sh:171-178` — background loop: `sleep 25`, then forever `curl -X POST
  .../api/cron/tick` with `x-cron-key`, `sleep 3600`. Granularity = **1 hour**. `CRON_KEY` auto-gen at `:167`.
- `app/src/app/api/cron/tick/route.ts:11-22` — auth-gates on `CRON_KEY`, calls `tickOnce()`.
- `app/src/lib/scheduler.ts:17-42` — `tickOnce()`: one-time `bootstrapEnvLogin()` (`:22-25`, process-guarded),
  `isSchedulerEnabled()` gate (`:27`), loads all `ScheduleState` (`:28`), `due = any nextCheckAt <= now`
  (`:30`), on `due || states.length===0` runs ONE `runScrape('SCHEDULED')` (`:33`). Catches
  `ScrapeBusyError`/`ScrapeThrottledError`.
- `app/src/lib/ngrid/run.ts`:
  - `inFlight` in-process guard (`:37`, `:90`, `:330`).
  - `MIN_SCHEDULED_GAP_MS = 5min` throttle for SCHEDULED only (`:17`, `:92-100`).
  - Creates `ScrapeRun` audit row (`:102`), throttled live-progress writer (`:111-146`, `PROGRESS_THROTTLE_MS`).
  - Per-login loop (`:160-247`): `collect()` once per login, `shouldSkipScheduled` skip (`:159-164`),
    graceful `needs_reauth` on auth failure (`:208-217`), `statusOnSuccess` stamp (`:241-246`).
  - Per account: `persist()` (`:221`) → `updateSchedule()` (`:222`) → inline `syncHistoricalWeather` (`:224-230`).
  - Inline post-pass: `notifyNewBills` (`:253-262`), `detectAnomalies`+`notifyAnomaly` (`:270-278`),
    `syncNotifications` (`:286-293`).
  - `updateSchedule()` (`:42-83`): pure `computeNextCheck(now, statementDates)` (`:54`) then the **two inline
    caps** — AMI 22h `INTERVAL_DAILY_CAP_MS` gated on `intervalUsage.count>0` (`:59-63`), PDF-pending 6h
    `PDF_PENDING_CAP_MS`/`PDF_PENDING_RECENT_DAYS=35` (`:70-77`) — writes `ScheduleState` (`:78-82`).
- `app/src/lib/ngrid/collect.ts` — login→discover→per-account scrape. Auth headers captured **mid-navigation**
  in `onRoute` (`:204-209`: `authorization` + `ocp-apim-subscription-key` + `origin`, gated by `haveAuth`).
  `collectOneAccount` (`:146`): dashboard/bill-history/energy-usage nav (`:252-260`), PDF download with
  `{...authHeaders,'account-number':accountNumber}` (`:425-450`), AMI interval pull reusing `authHeaders`
  (`:499-635`), `AUTO_BACKFILL_DAYS=400` first-run logic driven by injected `hasIntervalData` probe (`:515-522`).
- `app/src/lib/ngrid/auth.ts` — session reuse: `contextOptions(loginId)` loads `storageState` if present
  (`:107-116`), `ensureLoggedIn` reuse-or-login (`:338-363`), `saveState` per-login state file (`:129-137`).
- `app/src/lib/prediction.ts:111-121` — `computeNextCheck` PURE; `predictNextBill` (`:22`), `predictionWindow`
  (`:89`). **Stays unchanged.**
- Manual path: `app/src/app/api/refresh/route.ts:11-20` → `runScrape('MANUAL')`, returns `runId`. UI:
  `RefreshButton` + `ScrapeProgress` poll `/api/refresh/[id]` (→ `ScrapeRun.message`).
- Surfacing: `/api/runs` (`route.ts:7-20`), `SettingsView.tsx` `auto-check` block (`:255-281`) reads
  `server.schedule` (from `overview.schedule`, `queries.ts:368-372`); `recent-checks` block (`:282-318`).
- **Migration-safety gate** (`.github/migration-safety/check.sh`): seeds old schema, `db push
  --accept-data-loss` to new, asserts row-counts / column-inventory / value fingerprint unchanged across a
  fixed `TABLES` list (`:29`) that **does not yet include the new table**.

---

## 2. Schema design

### New model `ScheduledTask` (additive)

```prisma
model ScheduledTask {
  id         Int       @id @default(autoincrement())
  kind       String    // 'full-scrape' | 'pdf-fetch' | 'interval-pull' | 'weather-sync' | 'notify-sync'
  accountId  Int?
  account    Account?  @relation(fields: [accountId], references: [id], onDelete: Cascade)
  payload    Json      @default("{}")   // opaque to scheduler; per-account { accountId, loginId? }. Never a secret.
  enabled    Boolean   @default(true)
  nextRunAt  DateTime?                  // null = inactive/one-shot done; never selected as due
  lastRunAt  DateTime?
  lastStatus String?                    // 'SUCCESS' | 'ERROR' | 'SKIPPED'
  lastReason String?                    // short human note (cadence reason or error head, truncated)
  createdAt  DateTime  @default(now())
  updatedAt  DateTime  @updatedAt

  @@unique([kind, accountId])
  @@index([enabled, nextRunAt])
  @@index([kind])
}
```

- `@@unique` cannot target a JSON sub-field, so use a real nullable scalar `accountId` (as a relation with
  `onDelete: Cascade`, mirroring `ScheduleState`, so deleting an Account auto-cleans its tasks). All tasks
  here are per-account; global singletons would use `accountId = null` (Postgres treats multiple NULLs as
  distinct — fine).

### `ScheduleState` reconciliation — **KEEP IT (unchanged)**

The `full-scrape` handler keeps reading/writing `ScheduleState`. Reasons: it feeds the existing Settings UI
(`queries.ts:368-372` → `overview.schedule`); `predictedNextBillDate`/`lastCheckedAt` are genuinely
full-scrape state, not scheduler state. The scheduler owns only `ScheduledTask.nextRunAt`; the full-scrape
handler derives its returned `nextRunAt` from its own `ScheduleState` logic and keeps `nextCheckAt` as a
denormalized mirror for the UI. Non-destructive.

### Seed / backfill — idempotent, first-boot (`app/src/lib/scheduler/seed.ts`)

Called where `bootstrapEnvLogin()` is today (`scheduler.ts:22-25`), process-guarded **and** DB-idempotent
(`upsert ... update:{}` = no-op on re-run, so restarts/multi-process can't reset a live schedule).
Per existing `Account`:
- `full-scrape`: create `nextRunAt` from existing `ScheduleState.nextCheckAt` if present (preserve live
  cadence — no extra scrape), else `now`. Never overwrite on update.
- `interval-pull`: create enabled, `nextRunAt=now`; handler self-deactivates on first run if no AMI meter.
- `pdf-fetch`: `nextRunAt=now` if a recent pending PDF exists, else `null` (full-scrape re-arms it later).
- `weather-sync`, `notify-sync`: `nextRunAt=null` (reactive — full-scrape arms them after a successful scrape).

Brand-new install (zero accounts) seeds nothing; the bootstrap full-scrape runs via the "no tasks → initial"
path (§4 step 4). Accounts discovered later are seeded lazily by the full-scrape handler.

---

## 3. Core types

### `app/src/lib/scheduler/types.ts`

```ts
export type TaskKind = 'full-scrape' | 'pdf-fetch' | 'interval-pull' | 'weather-sync' | 'notify-sync';

export interface ScheduledTaskRow {
  id: number; kind: TaskKind; accountId: number | null;
  payload: Record<string, unknown>; nextRunAt: Date | null; enabled: boolean;
}

export interface TaskResult {
  nextRunAt: Date | null;                 // null = deactivate
  status: 'SUCCESS' | 'ERROR' | 'SKIPPED';
  reason?: string;
  arm?: { kind: TaskKind; accountId: number | null; nextRunAt: Date }[]; // e.g. full-scrape arms weather/notify/pdf-fetch
}

export interface TaskContext { task: ScheduledTaskRow; now: Date; log: ProgressFn; session: PortalSession | null; }

export type TaskHandler = { kind: TaskKind; portal: boolean; run(ctx: TaskContext): Promise<TaskResult>; };

export const HANDLERS: Record<TaskKind, TaskHandler>;
```

### `PortalSession` (`app/src/lib/ngrid/session.ts`) — the shared "class"

```ts
export interface PortalSession {
  readonly loginId?: number;
  page: Page; ctx: BrowserContext;
  authHeaders: Record<string, string> | null;     // {authorization, ocp-apim-subscription-key, origin}
  ensureAuthHeaders(): Promise<Record<string, string>>; // navigates to /dashboard to recapture if null
  saveState(): Promise<void>;
  close(): Promise<void>;
}
export async function acquirePortalSession(loginId: number | undefined, log: ProgressFn): Promise<PortalSession>;
```

**Lifecycle:** acquire (launch chromium → `contextOptions(loginId)` → `ensureLoggedIn` ONCE → attach a
persistent route handler capturing `authorization`+`ocp-apim-subscription-key` exactly as `collect.ts:204-209`)
→ handlers run sequentially → `saveState()` → `close()`.

**Auth-header subtlety (resolved):** persist captured headers ON the session. If `pdf-fetch`/`interval-pull`
fire on a tick where `full-scrape` did NOT run, `authHeaders` is null → `ensureAuthHeaders()` does ONE light
`/dashboard?accountLink=…` nav (one `page.goto` + 4s settle, matching `collect.ts:113`) to make the SPA fire
a gql request and populate the headers. At most one extra nav per tick; subsequent handlers reuse the cache.
**Preferred over a re-login.** Requires extracting the header-capture + PDF + interval HTTP logic out of
`collect.ts` (§6 step 2).

---

## 4. The generic runner (`app/src/lib/scheduler/runner.ts`, replaces `tickOnce`/`runScrape` orchestration)

`runTick()`:
1. `bootstrapEnvLogin()` + `seedScheduledTasks()` (process-guarded, as today).
2. `isSchedulerEnabled()` gate (unchanged).
3. **Generalized in-flight lock:** module-level `inFlight` (generalizes `run.ts:37`). If set → `{ran:false,
   reason:'busy'}`. Also blocks a manual run from double-firing (§6).
4. Load due: `scheduledTask.findMany({ where: { enabled:true, nextRunAt:{ lte: now } } })`. Fresh-install
   special case: if NO `full-scrape` tasks exist at all → synthesize an initial full-scrape pass (mirrors
   `scheduler.ts:31` `states.length===0`).
5. Split due into `portal` (`HANDLERS[kind].portal`) vs `nonPortal`.
6. **Throttle floor:** if any due portal task would run and the most recent SUCCESS portal run is within
   `MIN_SCHEDULED_GAP_MS` (5min), DEFER the portal tasks (push `nextRunAt` to `lastSuccess + gap`, don't run
   them this tick). Non-portal exempt.
7. Portal tasks: group by `loginId`. Per login → `acquirePortalSession(loginId)` ONCE → run that login's due
   portal handlers **sequentially** in fixed order (`full-scrape` → `interval-pull` → `pdf-fetch`, headers
   warm), each in its own try/catch (a failing task records ERROR + backoff `nextRunAt`, does NOT abort
   siblings — mirrors `run.ts:208-217`). Tear down session. Apply `arm[]` (full-scrape arms
   weather/notify/pdf-fetch by upserting `nextRunAt=now`).
8. Run `nonPortal` handlers (weather-sync, notify-sync), each isolated in try/catch.
9. Write back each task's `nextRunAt`/`lastRunAt`/`lastStatus`/`lastReason`.
10. **Audit:** keep `ScrapeRun` as the audit table (UI depends on it). Wrap the tick in ONE `ScrapeRun` row
    with the throttled live-progress writer lifted from `run.ts:111-146` into `app/src/lib/scheduler/progress.ts`.
    Final `message` summarizes per-task outcomes. Only create a `ScrapeRun` when at least one task ran (skip on
    a not-due tick, as today).

`tickOnce()` becomes a thin shim calling `runTick()` (cron route unchanged), behind the `SCHEDULER_V2` flag
during rollout.

---

## 5. Task handlers (`app/src/lib/scheduler/handlers/*.ts`)

Each owns its cadence via a **pure** fn in `lib/` fed DB facts gathered impurely (mirror the shipped
`hasIntervalData` injected-probe pattern).

- **`full-scrape` (portal):** runs `collect(session,{loginId})` (adapted to take a session) + `persist()` per
  account; then **arms** `weather-sync`, `notify-sync`, and (if recent pending PDF) `pdf-fetch` via `arm[]`.
  Cadence: `computeFullScrapeNextRun(now, { statementDates, hasIntervalData, hasRecentPendingPdf })` — wraps
  the unchanged `computeNextCheck` and applies the AMI/PDF caps (relocated here, kept pure, facts injected).
  Writes `ScheduleState` (predicted + nextCheckAt mirror), returns that as `nextRunAt`. NOTE: once
  `pdf-fetch`/`interval-pull` own those cadences, the caps on full-scrape can be dropped (final cleanup step);
  keep the AMI cap initially for safety.
- **`pdf-fetch` (portal) — the live pain point:** download recent `pdfPath=null` bills via the extracted PDF
  helper + `session.ensureAuthHeaders()` + `{'account-number':accountNumber}` (logic from `collect.ts:425-450`),
  parse, persist `currentCharges`+cost rows. Cadence `computePdfFetchNextRun`: pending recent count > 0 →
  `now + PDF_PENDING_CAP_MS` (~6h); 0 → **`null` (self-deactivate)**. Re-armed by full-scrape.
- **`interval-pull` (portal):** AMI interval fetch (`collect.ts:499-635` extracted) using session headers +
  the `hasIntervalData` first-run/400d-backfill probe. Cadence `computeIntervalNextRun`: daily (`now +
  INTERVAL_DAILY_CAP_MS`, ~22h) when an AMI meter exists; first run with no AMI meter → `null` + SKIPPED.
- **`weather-sync` (non-portal):** `syncHistoricalWeather(accountId)` (the `run.ts:224-230` block). Reactive:
  armed by full-scrape, runs once, returns `null`.
- **`notify-sync` (non-portal):** the `run.ts:253-293` block (`notifyNewBills` + `detectAnomalies`/`notifyAnomaly`
  + `syncNotifications`), all already idempotent/dedup-safe + SCHEDULED-only. Reactive, returns `null`.

All handlers keep the "never fail the run" try/catch posture; the runner isolates each task ("never fail the tick").

---

## 6. Manual-refresh path + live progress

- `runScrape('MANUAL')` (`refresh/route.ts:13`) stays as a thin wrapper that runs a **full portal pass now**:
  acquire a `PortalSession`, run `full-scrape` (+`interval-pull`+`pdf-fetch`) for all accounts immediately,
  bypassing `nextRunAt`/throttle (operator asked; matches today's "manual runs everything", `run.ts:160`).
  Shares the same `inFlight` lock → a manual run and a scheduled tick **cannot double-run** (second gets
  `ScrapeBusyError`/409). Same `ScrapeRun`/progress → `RefreshButton`/`ScrapeProgress` unchanged.
- Preserve "manual runs weather but stays silent on notify" (the `run.ts:253` `trigger==='SCHEDULED'` guard).

## 7. Tick granularity — **NO CHANGE (keep hourly)**

Tightest cadence is `pdf-fetch` ~6h / `interval-pull` ~22h; both tolerate hourly polling (a 6h target firing
at the next hourly tick is ≤~1h late — fine for a PDF that lags 1–3 days). The 5-min floor means a finer tick
gains nothing. State this explicitly in the PR so reviewers don't shrink it.

## 8. The 7-day projection

- **Pure simulator** (`app/src/lib/scheduler/projection.ts`, unit-tested): `projectTask(task, facts, now,
  horizonDays)` + `projectTimeline(tasks, now, days)`. For each enabled task, start at `nextRunAt`, repeatedly
  call its pure cadence fn on a virtual clock with **facts held constant**, append fires until `now+days`.
  Honest annotation: `pdf-fetch` under "pending" held constant projects every ~6h → **collapse** into one
  annotated entry ("every ~6h until the PDF publishes, then relaxes"); `weather`/`notify` are reactive
  (`nextRunAt=null`) → annotate "runs after the next full check", not periodic.
- **API** (`app/src/app/api/schedule/upcoming/route.ts`): model on `runs/route.ts` + `withAccount` gate.
  `GET /api/schedule/upcoming?days=7` → load this account's tasks + gather each task's facts impurely → 
  `projectTimeline` → `{ actions: ProjectedAction[] }`. `dynamic='force-dynamic'`, `runtime='nodejs'`. Clamp
  `days` to `[1,14]`.
- **UI** (`SettingsView.tsx`, `data-collection` group): a read-only `ControlBlock` `upcoming-actions` right
  after `recent-checks` (`:282`); render a small timeline (`relativeFromNow` + taskKind + reason/assumption).
  Add to `searchText`. No new chart component.

---

## 9. Ordered implementation checklist (PR-sized; land each behind the flag, verify on staging + `/api/verify` between steps)

1. **Schema + seed.** Add `ScheduledTask` + `Account` back-relation; add `seedScheduledTasks()`; **add
   `ScheduledTask` to `migration-safety/check.sh` TABLES + seed.sql**. Unit-test seed idempotency. Verify:
   `db push` clean, migration-safety green, `docker build --target test`.
2. **`PortalSession` extraction.** Carve header-capture + PDF-download + AMI-interval HTTP out of `collect.ts`
   into reusable fns taking `(page, ctx, authHeaders)`; add `session.ts`. **No behavior change** — `collect()`
   calls the extracted helpers. Verify: `/api/verify` green, `interval`/`parse` tests pass.
3. **Pure cadence fns + projection.** `computeFullScrapeNextRun`, `computePdfFetchNextRun`,
   `computeIntervalNextRun`, `projectTask`/`projectTimeline` + hand-calc unit tests (mirror
   `prediction.test.ts`). No wiring. Verify: tests.
4. **Generic runner + registry behind a flag.** Add `runner.ts`, `types.ts`, `HANDLERS`, handler files. Gate
   `tickOnce()` on `SCHEDULER_V2` (default OFF → old `runScrape` path). Verify: with flag on in a dev
   container, a tick runs tasks; `ScrapeRun` + progress shape identical.
5. **Migrate each concern to a task + manual path.** Point `runScrape('MANUAL')` at the portal-pass
   orchestration; confirm `RefreshButton`/`ScrapeProgress` unchanged. Verify: manual works, `/api/verify`
   green, notify/weather/interval all fire under V2.
6. **Projection view.** Add `/api/schedule/upcoming` + the `SettingsView` block. Verify: sane 7-day timeline.
7. **Flip flag + remove old path.** Default `SCHEDULER_V2` ON, delete the old `runScrape` monolith
   orchestration (keep extracted helpers). Optionally drop the AMI cap from full-scrape (interval-pull owns
   it now). Verify: full CI, `/api/verify`, migration-safety.

---

## 9b. Implementation refinements discovered during build (binding for steps 4b+)

These resolve gaps the original plan glossed; they do not change the architecture.

- **Rollout flag is an ENV var** `SCHEDULER_V2` (`=== 'true'`), read at call time — NOT an AppSetting
  (avoids live-toggle races; it's a deploy-time switch removed in step 7). Both entry points gate on it:
  `scheduler.tickOnce()` → `runTick('SCHEDULED')` when on, else the untouched old `runScrape` path; the
  manual `refresh` route → the runner's manual pass when on, else old `runScrape('MANUAL')`. Within a flag
  state a single `inFlight` governs, so manual+scheduled never double-run. **`run.ts` stays byte-identical**
  (its copy of the audit/progress/inFlight machinery is duplicated into `scheduler/progress.ts` for the
  runner; the old one is deleted in step 7, not edited now).
- **full-scrape is per-account in the table but login-wide in effect.** `collect()` scrapes ALL of a
  login's accounts in one session. To avoid double-scraping a multi-account login when several of its
  full-scrape tasks are due in one tick, the full-scrape handler **dedups per session**: it marks
  `session.scratch` once it has run `collect()` for that login; a second full-scrape invocation on the same
  session returns SKIPPED and just recomputes its own `nextRunAt`. The runner stays task-agnostic (no
  per-kind branching) — the handler self-dedups via session-scoped scratch. (`PortalSession` gains a
  `scratch: Record<string, unknown>` field.) For the operator's single-account prod this is simply one
  `collect()` per tick.
- **pdf-fetch / interval-pull reuse `persist()`** by building a PARTIAL `CollectResult` (account mapped from
  the DB row + only the targeted bills/costs, or only intervals; other arrays empty). `persist()`'s
  `?? undefined` bill updates won't clobber, and empty arrays skip — clean targeted writes, no new writer.
- **interval-pull needs meter metadata** (`servicePointNumber`/`hasAmiSmartMeter`) that lives only in the
  live gql `billingAccount` payload, not the DB. Standalone interval-pull does a light `/dashboard?accountLink`
  nav with a response capture for `billingAccount` (mirroring collect's discovery handler) to get the raw
  payload → `extractAmiMeters` → `fetchAmiIntervals` → persist. **Safety net:** the AMI 22h cap STAYS on
  full-scrape this whole rollout, so even a weak/ SKIPPED interval-pull leaves interval capture continuous
  (full-scrape pulls intervals daily). interval-pull is the optimization that lets step 7 drop that cap.
- **TaskContext carries `trigger: 'SCHEDULED' | 'MANUAL'`** so full-scrape arms `notify-sync` only on
  SCHEDULED (preserving "manual stays silent"); weather-sync is armed on both (matches run.ts: weather runs
  on manual, notify does not).
- **needs_reauth + env-cred passes:** the runner skips a login flagged `needs_reauth` on a SCHEDULED tick
  (login-level, mirrors run.ts:158-164); a login with no NgLogin row → env-cred pass (`loginId` undefined).
  full-scrape catches collect's auth failure, `classifyLoginError`, flips NgLogin `needs_reauth`, returns
  ERROR+backoff without aborting the tick (mirrors run.ts:199-218, 241-246).

## 10. Risks / good-guest

- **≤1 login/tick:** one `acquirePortalSession` per login per tick; all that login's portal handlers reuse
  `session.page`. Multiple accounts under one login = one session (as `collect()` today). Multiple logins =
  sequential sessions, never parallel (preserve `run.ts:160`).
- **Sequential portal access:** handlers for a session run in fixed sequence on the single `page`; shared
  mutable browser state never touched concurrently. Document in `runner.ts`.
- **No sub-`MIN_SCHEDULED_GAP_MS`:** runner enforces the 5-min floor on portal tasks; cadence fns' tightest is 6h.
- **pdf-fetch relaxes:** `computePdfFetchNextRun` returns `null` when no recent pending PDF — unit-proven.
- **Manual ≠ double-run:** shared `inFlight` lock; concurrent tick → `ScrapeBusyError`/409.
- **Task-failure isolation:** each handler try/caught in the runner; error → `lastStatus:'ERROR'` + backoff
  `nextRunAt`, continue. Auth failure flips the login `needs_reauth` and skips its remaining portal tasks
  (lift `classifyLoginError`/`statusOnSuccess` from `run.ts:208-246`). One task's failure never aborts the
  tick or siblings.
- **Migration safety:** gate must prove the additive `ScheduledTask` table doesn't drop/clobber any existing
  row/column/fingerprinted value across `db push --accept-data-loss`, and that keeping `ScheduleState`
  unchanged leaves its rows intact. Add `ScheduledTask` to the gate's TABLES + seed.sql. Seed runs at boot
  after `db push`, idempotently → a restart/redeploy can't duplicate or reset live schedules.

---

## Critical files
- `app/src/lib/ngrid/run.ts` · `app/src/lib/ngrid/collect.ts` · `app/src/lib/ngrid/auth.ts`
- `app/prisma/schema.prisma` · `app/src/lib/scheduler.ts` · `app/src/lib/prediction.ts`
- `app/src/components/SettingsView.tsx` · `app/src/app/api/runs/route.ts` (template for new route)
- New: `app/src/lib/scheduler/{types,runner,seed,projection,progress,cadence}.ts`,
  `app/src/lib/scheduler/handlers/*.ts`, `app/src/lib/ngrid/session.ts`,
  `app/src/app/api/schedule/upcoming/route.ts`, `app/test/scheduler*.test.ts`
