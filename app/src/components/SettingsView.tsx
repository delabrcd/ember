'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { usePrefs } from '@/lib/prefs';
import { resolveSelectedAccountId, type AccountSummary } from '@/lib/accountSwitcher';
import { resolveRange, ymOfDate, ymdToYm } from '@/lib/range';
import { dateLabel, relativeFromNow } from '@/lib/format';
import { taskKindLabel } from '@/lib/scheduler/tasks';
import type { TaskKind } from '@/lib/scheduler/types';
import { matchesSearch } from '@/lib/settingsSearch';
import { RefreshButton } from './RefreshButton';
import { RangeControl } from './RangeControl';
import { NgLoginsSection } from './NgLoginsSection';

interface ServerSettings {
  schedulerEnabled: boolean;
  notify?: { channel: string; configured: boolean; lastNotifiedStatementDate: string | null };
  schedule: { predictedNextBillDate: string | null; nextCheckAt: string | null; lastCheckedAt: string | null } | null;
  account: { accountNumber: string; serviceAddress?: string | null; region?: string | null; companyCode?: string | null; fuelTypes?: string[] } | null;
  billCount: number;
  firstStatement: string | null;
  latestBill: { statementDate: string; totalDueAmount: number | null } | null;
  // Carbon-footprint estimate (issue #49). The raw grid-factor override (empty
  // when unset) and the effective factor actually used (region default or override).
  gridEmissionFactor?: string;
  effectiveGridFactor?: number;
  // Budget / annual-spend target (issue #46). The raw target dollars (empty when
  // unset). Calendar-year window; tracked on the dashboard's budget card.
  budgetTarget?: string;
  // Anomaly alert on a flagged new bill (issue #45). OFF by default; reuses the
  // configured new-bill notification channel.
  anomalyNotifyEnabled?: boolean;
}
interface Run {
  id: number;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  billsAdded: number;
  message: string | null;
}

// One projected scheduler action from GET /api/schedule/upcoming.
interface UpcomingAction {
  kind: TaskKind;
  at: string | null;
  reason: string;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 rounded-full transition ${checked ? 'bg-amber-500' : 'bg-slate-700'}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white transition ${checked ? 'left-[22px]' : 'left-0.5'}`} />
    </button>
  );
}

// ── Group definitions ─────────────────────────────────────────────────────────

type GroupId =
  | 'accounts'
  | 'data-collection'
  | 'notifications'
  | 'display'
  | 'analytics'
  | 'system';

interface GroupDef {
  id: GroupId;
  label: string;
}

const GROUPS: GroupDef[] = [
  { id: 'accounts',        label: 'Accounts & login' },
  { id: 'data-collection', label: 'Data collection' },
  { id: 'notifications',   label: 'Notifications' },
  { id: 'display',         label: 'Display' },
  { id: 'analytics',       label: 'Dashboard & analytics' },
  { id: 'system',          label: 'System / about' },
];

// ── Component ─────────────────────────────────────────────────────────────────

export function SettingsView() {
  const { prefs, patch, setRange, reset } = usePrefs();
  const [server, setServer] = useState<ServerSettings | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [upcoming, setUpcoming] = useState<UpcomingAction[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [savingSched, setSavingSched] = useState(false);
  // Carbon-footprint grid-factor override (issue #49). Local edit buffer for the
  // input; seeded from the server value once loaded. Empty = use region default.
  const [gridFactor, setGridFactor] = useState('');
  const [savingGrid, setSavingGrid] = useState(false);
  // Budget / annual-spend target (issue #46). Local edit buffer; seeded from the
  // server value once loaded. Empty = no target (the dashboard budget card hides).
  const [budgetTarget, setBudgetTarget] = useState('');
  const [savingBudget, setSavingBudget] = useState(false);
  // Anomaly alert toggle (issue #45). OFF by default; saved on flip like the
  // scheduler toggle.
  const [savingAnomaly, setSavingAnomaly] = useState(false);
  const [verify, setVerify] = useState<{ ok: boolean; total: number; failed: number; bills: { statementDate: string; ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] }[] } | null>(null);
  const [verifying, setVerifying] = useState(false);
  // Bill-PDF bulk-download range. Empty until the user (or the loaded account)
  // fills them; defaulted once we know the account's first/last statement.
  const [pdfFrom, setPdfFrom] = useState('');
  const [pdfTo, setPdfTo] = useState('');

  // ── Tab / search UI state (in-memory only; not persisted) ──────────────────
  const [activeGroup, setActiveGroup] = useState<GroupId>('accounts');
  const [query, setQuery] = useState('');

  const runVerify = async () => {
    setVerifying(true);
    setVerify(null);
    const r = await fetch('/api/verify', { cache: 'no-store' }).then((x) => x.json());
    setVerify(r);
    setVerifying(false);
  };

  const loadServer = useCallback(async () => {
    const [s, r, a, u] = await Promise.all([
      fetch('/api/settings', { cache: 'no-store' }).then((x) => x.json()),
      fetch('/api/runs', { cache: 'no-store' }).then((x) => x.json()),
      fetch('/api/accounts', { cache: 'no-store' }).then((x) => x.json()),
      fetch('/api/schedule/upcoming?days=7', { cache: 'no-store' }).then((x) => x.json()),
    ]);
    setServer(s);
    setRuns(r.runs || []);
    setAccounts(a.accounts || []);
    setUpcoming(u.actions || []);
    setGridFactor(s.gridEmissionFactor ?? '');
    setBudgetTarget(s.budgetTarget ?? '');
  }, []);

  // Match the dashboard's scoping so an export = what's on screen. Validate the
  // persisted selection against the live list (a stale id is ignored → default
  // account); only a real, non-default selection adds a query param.
  const selectedAccountId = resolveSelectedAccountId(accounts, prefs.selectedAccountId);

  // The selected date range scopes the CSV exports too (issue #24), matching the
  // dashboard. We only know the account's first/last statement here, which is all
  // resolveRange needs to clamp/anchor (min/max), so build allYms from those.
  const nowYm = ymOfDate(new Date());
  const allYms = [ymdToYm(server?.firstStatement), ymdToYm(server?.latestBill?.statementDate)].filter(
    (y): y is number => y != null
  );
  const resolved = resolveRange(prefs.range, allYms, nowYm);
  // Account-only scope (the PDF bundle has its own from/to ISO date inputs below);
  // CSV exports additionally carry the selected ym range so they match the dashboard.
  const acctScope = selectedAccountId != null ? `&accountId=${selectedAccountId}` : '';
  const exportScope = `${acctScope}&from=${resolved.fromYm}&to=${resolved.toYm}`;

  useEffect(() => {
    loadServer();
  }, [loadServer]);

  // Seed the bulk-PDF range to the account's full history once it's known, but
  // never clobber a value the user has already set.
  useEffect(() => {
    if (server?.firstStatement) setPdfFrom((v) => v || server.firstStatement!);
    if (server?.latestBill?.statementDate) setPdfTo((v) => v || server.latestBill!.statementDate);
  }, [server?.firstStatement, server?.latestBill?.statementDate]);

  const pdfRangeValid = !!pdfFrom && !!pdfTo && pdfFrom <= pdfTo;
  const pdfExportQuery = `?from=${pdfFrom}&to=${pdfTo}${acctScope}`;

  const setScheduler = async (enabled: boolean) => {
    setSavingSched(true);
    setServer((s) => (s ? { ...s, schedulerEnabled: enabled } : s));
    await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schedulerEnabled: enabled }) });
    setSavingSched(false);
    loadServer();
  };

  // Toggle the anomaly alert on a flagged new bill (issue #45). OFF by default;
  // optimistic update then reload. Reuses the configured notification channel.
  const setAnomalyNotify = async (enabled: boolean) => {
    setSavingAnomaly(true);
    setServer((s) => (s ? { ...s, anomalyNotifyEnabled: enabled } : s));
    await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ anomalyNotifyEnabled: enabled }) });
    setSavingAnomaly(false);
    loadServer();
  };

  // Save (or clear) the carbon-estimate grid-factor override. The server validates
  // it's a positive number before storing; an empty value reverts to the region
  // eGRID default. We reload so the displayed "effective" factor reflects the result.
  const saveGridFactor = async () => {
    setSavingGrid(true);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gridEmissionFactor: gridFactor.trim() }),
    });
    setSavingGrid(false);
    loadServer();
  };

  // Save (or clear) the annual-spend budget target (issue #46). The server
  // validates it's a positive number before storing; an empty value clears it
  // (the dashboard budget card disappears). Reload so the saved state reflects.
  const saveBudgetTarget = async () => {
    setSavingBudget(true);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budgetTarget: budgetTarget.trim() }),
    });
    setSavingBudget(false);
    loadServer();
  };

  // ── Control blocks (defined here so they close over state/handlers) ─────────
  // Each block has: group id, searchable text, and its JSX node.
  // Tab view renders blocks whose group matches activeGroup.
  // Search view renders blocks whose searchText matches the query.
  interface ControlBlock {
    key: string;
    group: GroupId;
    searchText: string;
    node: React.ReactNode;
  }

  const blocks: ControlBlock[] = [
    // ── Accounts & login ──────────────────────────────────────────────────────
    {
      key: 'account-info',
      group: 'accounts',
      searchText: 'account login account number service address company fuels bills history',
      node: (
        <div key="account-info">
          {server?.account ? (
            <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
              <div><span className="text-slate-500">Account</span> <span className="text-slate-200">{server.account.accountNumber}</span></div>
              <div><span className="text-slate-500">Service address</span> <span className="text-slate-200">{server.account.serviceAddress || '—'}</span></div>
              <div><span className="text-slate-500">Company</span> <span className="text-slate-200">{server.account.companyCode || '—'}</span></div>
              <div><span className="text-slate-500">Fuels</span> <span className="text-slate-200">{server.account.fuelTypes?.join(', ') || '—'}</span></div>
              <div><span className="text-slate-500">Bills stored</span> <span className="text-slate-200">{server.billCount}</span></div>
              <div><span className="text-slate-500">History</span> <span className="text-slate-200">{dateLabel(server.firstStatement)} → {dateLabel(server.latestBill?.statementDate)}</span></div>
            </div>
          ) : (
            <p className="text-sm text-slate-400">No account data yet — run a check from the dashboard.</p>
          )}
        </div>
      ),
    },
    {
      key: 'ng-logins',
      group: 'accounts',
      searchText: 'National Grid logins credentials login username password authentication',
      node: (
        <div key="ng-logins" className="border-t border-slate-800 pt-4">
          <NgLoginsSection />
        </div>
      ),
    },

    // ── Data collection ───────────────────────────────────────────────────────
    {
      key: 'auto-check',
      group: 'data-collection',
      searchText: 'automatic bill checking scheduler predicted next bill last checked next auto-check manually pull refresh',
      node: (
        <div key="auto-check" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-200">Automatic bill checking</div>
              <div className="text-xs text-slate-500">
                Predicts your next statement and checks more often as it nears. {savingSched ? 'Saving…' : ''}
              </div>
            </div>
            <Toggle checked={!!server?.schedulerEnabled} onChange={setScheduler} />
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="pill">Predicted next bill <strong className="text-slate-100">{dateLabel(server?.schedule?.predictedNextBillDate)}</strong></span>
            <span className="pill">Last checked {relativeFromNow(server?.schedule?.lastCheckedAt)}</span>
            <span className="pill">Next auto-check {server?.schedulerEnabled ? relativeFromNow(server?.schedule?.nextCheckAt) : 'paused'}</span>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <RefreshButton onDone={loadServer} />
            <span className="text-xs text-slate-500">Manually pull the latest bills now.</span>
          </div>
        </div>
      ),
    },
    {
      key: 'recent-checks',
      group: 'data-collection',
      searchText: 'recent checks runs log collection history trigger status result',
      node: (
        <div key="recent-checks" className="border-t border-slate-800 pt-4">
          <h3 className="mb-3 text-sm font-semibold text-slate-300">Recent checks</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-2">When</th>
                  <th className="px-2 py-2">Trigger</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Result</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className="border-t border-slate-800/70">
                    <td className="px-2 py-2 text-slate-300">{relativeFromNow(r.startedAt)}</td>
                    <td className="px-2 py-2 text-slate-400">{r.trigger}</td>
                    <td className="px-2 py-2">
                      <span className={r.status === 'SUCCESS' ? 'text-emerald-400' : r.status === 'ERROR' ? 'text-rose-400' : 'text-amber-400'}>{r.status}</span>
                    </td>
                    <td className="px-2 py-2 text-slate-400">{r.message || '—'}</td>
                  </tr>
                ))}
                {runs.length === 0 && (
                  <tr><td className="px-2 py-3 text-slate-500" colSpan={4}>No checks yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ),
    },
    {
      key: 'upcoming-actions',
      group: 'data-collection',
      searchText: 'upcoming scheduled actions next 7 days timeline projection full check fetch pdf interval weather notifications planned',
      node: (
        <div key="upcoming-actions" className="border-t border-slate-800 pt-4">
          <h3 className="mb-1 text-sm font-semibold text-slate-300">Upcoming actions (next 7 days)</h3>
          <p className="mb-3 text-xs text-slate-500">
            Projected from each task’s cadence. A “—” means no fixed time — that task runs in
            response to a full check (see Details).
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-2 py-2">When</th>
                  <th className="px-2 py-2">Action</th>
                  <th className="px-2 py-2">Details</th>
                </tr>
              </thead>
              <tbody>
                {upcoming.map((a, i) => (
                  <tr key={i} className="border-t border-slate-800/70">
                    <td className="px-2 py-2 text-slate-300">{a.at ? relativeFromNow(a.at) : '—'}</td>
                    <td className="px-2 py-2 text-slate-400">{taskKindLabel(a.kind)}</td>
                    <td className="px-2 py-2 text-slate-400">{a.reason}</td>
                  </tr>
                ))}
                {upcoming.length === 0 && (
                  <tr><td className="px-2 py-3 text-slate-500" colSpan={3}>No scheduled actions</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ),
    },

    // ── Notifications ─────────────────────────────────────────────────────────
    {
      key: 'new-bill-notify',
      group: 'notifications',
      searchText: 'new-bill notifications channel configured off sent scheduled checks',
      node: (
        <div key="new-bill-notify">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-200">New-bill notifications</div>
              <div className="text-xs text-slate-500">
                Sent once per new bill on scheduled checks. Configured via environment — off by default.
              </div>
            </div>
            <span className={`pill ${server?.notify?.configured ? 'border-amber-500/60 text-amber-300' : 'opacity-60'}`}>
              {server?.notify?.configured ? `via ${server.notify.channel}` : 'off'}
            </span>
          </div>
          {server?.notify?.lastNotifiedStatementDate && (
            <div className="mt-2 text-xs text-slate-500">
              Last notified through statement <span className="text-slate-300">{dateLabel(server.notify.lastNotifiedStatementDate)}</span>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'anomaly-notify',
      group: 'notifications',
      searchText: 'alert on bill anomalies anomaly usage price weather outside normal channel',
      node: (
        <div key="anomaly-notify" className="border-t border-slate-800 pt-4">
          {/* Anomaly alert on a flagged new bill (issue #45). OFF by default;
              reuses the configured channel above and only fires when a scheduled
              scrape brings in a bill whose weather-normalized usage or all-in rate
              is well outside its robust trailing baseline (at most once per bill). */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-200">Alert on bill anomalies</div>
              <div className="text-xs text-slate-500">
                Sends one alert on the channel above when a new bill&apos;s usage (after accounting for the weather) or
                price is well outside your recent normal. {savingAnomaly ? 'Saving…' : 'Off by default.'}
                {server?.notify && !server.notify.configured ? ' Configure a channel (above) for this to send.' : ''}
              </div>
            </div>
            <Toggle checked={!!server?.anomalyNotifyEnabled} onChange={setAnomalyNotify} />
          </div>
        </div>
      ),
    },

    // ── Display ───────────────────────────────────────────────────────────────
    {
      key: 'date-range',
      group: 'display',
      searchText: 'date range charts bills list exports',
      node: (
        <div key="date-range" className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-200">Date range</div>
            <div className="text-xs text-slate-500">Drives the charts, the bills list, and the exports below</div>
          </div>
          <RangeControl range={prefs.range} onChange={setRange} allYms={allYms} nowYm={nowYm} />
        </div>
      ),
    },
    {
      key: 'currency-decimals',
      group: 'display',
      searchText: 'currency decimals cents dollar amounts',
      node: (
        <div key="currency-decimals" className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-200">Currency decimals</div>
            <div className="text-xs text-slate-500">Cents shown on dollar amounts</div>
          </div>
          <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
            {[0, 2].map((d) => (
              <button key={d} onClick={() => patch({ currencyDecimals: d })}
                className={`px-3 py-1 text-xs transition ${prefs.currencyDecimals === d ? 'bg-amber-500 text-slate-950' : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'}`}>
                {d === 0 ? '$0' : '$0.00'}
              </button>
            ))}
          </div>
        </div>
      ),
    },
    {
      key: 'projection',
      group: 'display',
      searchText: '12-month projection charts cost usage dashed estimate on charts',
      node: (
        <div key="projection" className="space-y-3">
          <div>
            <div className="text-sm font-medium text-slate-200">12-month projection</div>
            <div className="text-xs text-slate-500">Show an estimate of the next 12 months as a dashed line on the cost &amp; usage charts. The estimated yearly total now lives in the Budget tool (Tools &rarr; Budget), so there&rsquo;s no longer a separate summary card.</div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3 pl-3">
            <div className="text-xs text-slate-400">On charts <span className="text-slate-600">— dashed projected series on cost &amp; usage</span></div>
            <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
              {([true, false] as const).map((on) => (
                <button key={String(on)} onClick={() => patch({ showProjectionOnCharts: on })}
                  className={`px-3 py-1 text-xs transition ${prefs.showProjectionOnCharts === on ? 'bg-amber-500 text-slate-950' : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'}`}>
                  {on ? 'On' : 'Off'}
                </button>
              ))}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'reset-display',
      group: 'display',
      searchText: 'reset display settings defaults',
      node: (
        <div key="reset-display">
          <button onClick={reset} className="btn border border-slate-700/70 bg-slate-800/40 text-xs text-slate-300 hover:bg-slate-700">
            Reset display settings to defaults
          </button>
        </div>
      ),
    },

    // ── Dashboard & analytics ─────────────────────────────────────────────────
    {
      key: 'budget-target',
      group: 'analytics',
      searchText: 'annual spending target budget energy calendar year dashboard budget card',
      node: (
        <div key="budget-target" className="space-y-2">
          {/* Budget / annual-spend target (issue #46). A positive dollar target,
              tracked on the dashboard's budget card (spent so far vs a projected
              end-of-year total). Calendar-year window. Blank clears it. */}
          <div>
            <div className="text-sm font-medium text-slate-200">Annual spending target</div>
            <div className="text-xs text-slate-500">
              How much you want to spend on energy this calendar year. The dashboard shows a budget card with
              how much you&apos;ve spent so far and an estimated end-of-year total, plus whether you&apos;re on track.
              Leave blank to hide the card.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-3">
            <input
              type="number"
              step="50"
              min="0"
              inputMode="decimal"
              value={budgetTarget}
              placeholder="e.g. 2800"
              onChange={(e) => setBudgetTarget(e.target.value)}
              className="w-32 rounded-lg border border-slate-700 bg-slate-800/50 px-2 py-1 text-xs text-slate-200"
            />
            <button
              onClick={saveBudgetTarget}
              disabled={savingBudget || budgetTarget === (server?.budgetTarget ?? '')}
              className="btn border border-slate-700/70 bg-slate-800/40 text-xs text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
            >
              {savingBudget ? 'Saving…' : 'Save'}
            </button>
            {server?.budgetTarget ? (
              <span className="text-xs text-slate-500">
                Target: <span className="text-slate-300">${server.budgetTarget}/yr</span>
              </span>
            ) : (
              <span className="text-xs text-slate-500">No target set</span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'grid-factor',
      group: 'analytics',
      searchText: 'carbon estimate grid factor electricity green renewable plan region eGRID kg/kWh',
      node: (
        <div key="grid-factor" className="space-y-2">
          {/* Carbon-footprint estimate grid factor (issue #49). Server-side runtime
              setting (AppSetting), not a browser pref, so it changes the estimate for
              every viewer. A location-based ESTIMATE — never touches a cost number. */}
          <div>
            <div className="text-sm font-medium text-slate-200">Carbon estimate — grid factor</div>
            <div className="text-xs text-slate-500">
              Carbon per unit of electricity, used for the carbon estimate. Leave blank to use your region&apos;s
              grid average; set your own if you&apos;re on a green or renewable plan. Gas uses a standard
              published factor.
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pl-3">
            <input
              type="number"
              step="0.001"
              min="0"
              inputMode="decimal"
              value={gridFactor}
              placeholder={server?.account?.region ? 'region default' : ''}
              onChange={(e) => setGridFactor(e.target.value)}
              className="w-32 rounded-lg border border-slate-700 bg-slate-800/50 px-2 py-1 text-xs text-slate-200"
            />
            <button
              onClick={saveGridFactor}
              disabled={savingGrid || gridFactor === (server?.gridEmissionFactor ?? '')}
              className="btn border border-slate-700/70 bg-slate-800/40 text-xs text-slate-200 transition hover:bg-slate-700 disabled:opacity-40"
            >
              {savingGrid ? 'Saving…' : 'Save'}
            </button>
            {server?.effectiveGridFactor != null && (
              <span className="text-xs text-slate-500">
                In use: <span className="text-slate-300">{server.effectiveGridFactor} kg/kWh</span>
                {server.gridEmissionFactor ? '' : ' (region default)'}
              </span>
            )}
          </div>
        </div>
      ),
    },

    // ── System / about ────────────────────────────────────────────────────────
    {
      key: 'version',
      group: 'system',
      searchText: 'version about app',
      node: (
        <div key="version" className="flex items-center gap-2 text-sm">
          <span className="text-slate-500">Version</span>
          <span className="font-mono text-slate-200">v{process.env.NEXT_PUBLIC_APP_VERSION || 'dev'}</span>
        </div>
      ),
    },
    {
      key: 'verify',
      group: 'system',
      searchText: 'data check verify all bills numbers statements double-check',
      node: (
        <div key="verify" className="border-t border-slate-800 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-200">Data check</div>
              <div className="text-xs text-slate-500">Double-check that the numbers shown here match your actual bills.</div>
            </div>
            <button className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700" onClick={runVerify} disabled={verifying}>
              {verifying ? 'Verifying…' : 'Verify all bills'}
            </button>
          </div>
          {verify && (
            <div className="mt-3 text-sm">
              {verify.ok ? (
                <p className="text-emerald-400">✓ All {verify.total} bills match your actual statements exactly.</p>
              ) : (
                <div className="text-rose-400">
                  <p>✗ {verify.failed} of {verify.total} bills have mismatches:</p>
                  <ul className="mt-1 space-y-1 text-xs">
                    {verify.bills.filter((b) => !b.ok).flatMap((b) =>
                      b.checks.filter((c) => !c.ok).map((c, i) => (
                        <li key={b.statementDate + i} className="text-rose-300">
                          {b.statementDate}: {c.name} {c.detail ? `— ${c.detail}` : ''}
                        </li>
                      ))
                    )}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'export-csv',
      group: 'system',
      searchText: 'download CSV export series bills spreadsheet',
      node: (
        <div key="export-csv" className="border-t border-slate-800 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-200">Download CSV</div>
              <div className="text-xs text-slate-500">Export the monthly series or the bills list as a spreadsheet-ready file.</div>
            </div>
            <div className="flex flex-wrap gap-2">
              <a className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700" href={`/api/export?dataset=series${exportScope}`} download>
                Series
              </a>
              <a className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700" href={`/api/export?dataset=bills${exportScope}`} download>
                Bills
              </a>
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'export-pdfs',
      group: 'system',
      searchText: 'download bill PDFs archive date range tgz zip export',
      node: (
        <div key="export-pdfs" className="border-t border-slate-800 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-200">Download bill PDFs</div>
              <div className="text-xs text-slate-500">Bundle every bill PDF in a date range into one archive (tgz on Linux, zip on Windows/macOS).</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input type="date" value={pdfFrom} max={pdfTo || undefined} onChange={(e) => setPdfFrom(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-800/50 px-2 py-1 text-xs text-slate-200" />
              <span className="text-xs text-slate-500">to</span>
              <input type="date" value={pdfTo} min={pdfFrom || undefined} onChange={(e) => setPdfTo(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-800/50 px-2 py-1 text-xs text-slate-200" />
              {pdfRangeValid ? (
                <a className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700" href={`/api/export/pdfs${pdfExportQuery}`} download>
                  Download PDFs
                </a>
              ) : (
                <button className="btn cursor-not-allowed border border-slate-800 bg-slate-900/40 text-slate-500" disabled>
                  Download PDFs
                </button>
              )}
            </div>
          </div>
        </div>
      ),
    },
    {
      key: 'backup',
      group: 'system',
      searchText: 'full backup database bill PDFs restore archive NGRID_SECRET_KEY',
      node: (
        <div key="backup" className="border-t border-slate-800 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-200">Full backup</div>
              <div className="text-xs text-slate-500">Download a single restorable archive of the whole app: the database plus every bill PDF.</div>
            </div>
            <a className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700" href="/api/backup" download>
              Download full backup
            </a>
          </div>
          <div className="mt-2 text-xs text-slate-500">
            Database + bill PDFs. Keep your NGRID_SECRET_KEY backed up separately — it&apos;s required to restore saved logins and is not in the archive.
          </div>
        </div>
      ),
    },
  ];

  // ── Render helpers ────────────────────────────────────────────────────────

  const isSearching = query.trim() !== '';

  // Group panel (tab view)
  const groupBlocks = blocks.filter((b) => b.group === activeGroup);

  // Search results view — group matched blocks by their group, preserving group order
  const searchBlocks = blocks.filter((b) => matchesSearch(b.searchText, query));
  const searchGroupsWithBlocks: { group: GroupDef; blocks: ControlBlock[] }[] = GROUPS.map((g) => ({
    group: g,
    blocks: searchBlocks.filter((b) => b.group === g.id),
  })).filter((x) => x.blocks.length > 0);

  // Group storage labels
  const storageLabel: Record<GroupId, string> = {
    accounts:         'server-wide',
    'data-collection': 'server-wide',
    notifications:    'server-wide',
    display:          'stored in this browser',
    analytics:        'server-wide',
    system:           'server-wide',
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-50">Settings</h1>
          <p className="mt-1 text-sm text-slate-400">
            Display preferences are{' '}
            <span className="text-slate-300">stored in this browser</span>
            {' '}— all other settings{' '}
            <span className="text-slate-300">apply server-wide</span>.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Search box */}
          <div className="relative">
            <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
            </svg>
            <input
              type="search"
              placeholder="Search settings…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-8 w-48 rounded-lg border border-slate-700 bg-slate-800/50 pl-8 pr-3 text-xs text-slate-200 placeholder-slate-500 focus:border-amber-500/60 focus:outline-none"
            />
          </div>
          <Link href="/" className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700">← Dashboard</Link>
        </div>
      </header>

      {/* Main layout: left rail (desktop) / tab strip (mobile) + content panel */}
      <div className="flex flex-col gap-0 md:flex-row md:gap-6">

        {/* Left rail / tab strip */}
        <nav
          aria-label="Settings sections"
          className={`mb-4 flex flex-row flex-wrap gap-1 md:mb-0 md:w-48 md:flex-col md:flex-nowrap md:gap-0.5 md:shrink-0 ${isSearching ? 'opacity-40 pointer-events-none select-none' : ''}`}
        >
          {GROUPS.map((g) => (
            <button
              key={g.id}
              onClick={() => setActiveGroup(g.id)}
              className={`rounded-lg px-3 py-2 text-left text-sm transition
                ${activeGroup === g.id && !isSearching
                  ? 'bg-amber-500/15 text-amber-300 font-medium'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                }`}
            >
              {g.label}
            </button>
          ))}
        </nav>

        {/* Content panel */}
        <div className="min-w-0 flex-1">
          {isSearching ? (
            /* Search results view */
            <div className="card space-y-0">
              {searchGroupsWithBlocks.length === 0 ? (
                <p className="py-4 text-sm text-slate-500">No settings match &ldquo;{query}&rdquo;</p>
              ) : (
                searchGroupsWithBlocks.map(({ group, blocks: gblocks }) => (
                  <div key={group.id} className="py-2">
                    <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{group.label}</div>
                    <div className="space-y-4 pl-1">
                      {gblocks.map((b) => (
                        <div key={b.key}>{b.node}</div>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            /* Tab group panel */
            <section className="card space-y-5">
              {/* Group header */}
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold text-slate-100">
                  {GROUPS.find((g) => g.id === activeGroup)?.label}
                </h2>
                <span className="text-xs text-slate-500">{storageLabel[activeGroup]}</span>
              </div>

              {/* Group controls */}
              <div className="space-y-5">
                {groupBlocks.map((b) => (
                  <div key={b.key}>{b.node}</div>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
