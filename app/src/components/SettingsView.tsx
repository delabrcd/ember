'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { SPEC_BY_ID } from '@/lib/chartSpec';
import { usePrefs } from '@/lib/prefs';
import { useDashboardLayout } from './useDashboardLayout';
import { resolveSelectedAccountId, type AccountSummary } from '@/lib/accountSwitcher';
import { resolveRange, ymOfDate, ymdToYm } from '@/lib/range';
import { dateLabel, relativeFromNow } from '@/lib/format';
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

export function SettingsView() {
  const { prefs, loaded, patch, setRange, reset } = usePrefs();
  const [server, setServer] = useState<ServerSettings | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
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

  const runVerify = async () => {
    setVerifying(true);
    setVerify(null);
    const r = await fetch('/api/verify', { cache: 'no-store' }).then((x) => x.json());
    setVerify(r);
    setVerifying(false);
  };

  const loadServer = useCallback(async () => {
    const [s, r, a] = await Promise.all([
      fetch('/api/settings', { cache: 'no-store' }).then((x) => x.json()),
      fetch('/api/runs', { cache: 'no-store' }).then((x) => x.json()),
      fetch('/api/accounts', { cache: 'no-store' }).then((x) => x.json()),
    ]);
    setServer(s);
    setRuns(r.runs || []);
    setAccounts(a.accounts || []);
    setGridFactor(s.gridEmissionFactor ?? '');
    setBudgetTarget(s.budgetTarget ?? '');
  }, []);

  // Match the dashboard's scoping so an export = what's on screen. Validate the
  // persisted selection against the live list (a stale id is ignored → default
  // account); only a real, non-default selection adds a query param.
  const selectedAccountId = resolveSelectedAccountId(accounts, prefs.selectedAccountId);

  // Server-side dashboard DEFINITION (Phase D, #96). The "Charts shown & order"
  // editor below now reads/writes the SERVER layout (per account) instead of the
  // localStorage prefs.{order,charts}. Scoped to the same resolved account as the
  // exports; gated on prefs `loaded` so the first fetch targets the persisted
  // selection. updateChart toggles a chart's visibility; reorder moves it.
  const { layout, layoutLoading, updateChart: updateLayoutChart, reorder } = useDashboardLayout(
    selectedAccountId,
    loaded
  );

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

  return (
    <div className="space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-50">Settings</h1>
          <p className="mt-1 text-sm text-slate-400">Display preferences are stored in this browser; automation settings apply server-wide.</p>
        </div>
        <Link href="/" className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700">← Dashboard</Link>
      </header>

      {/* Display preferences */}
      <section className="card space-y-5">
        <h2 className="text-lg font-semibold text-slate-100">Display</h2>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-200">Date range</div>
            <div className="text-xs text-slate-500">Drives the charts, the bills list, and the exports below</div>
          </div>
          <RangeControl range={prefs.range} onChange={setRange} allYms={allYms} nowYm={nowYm} />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-medium text-slate-200">Layout density</div>
            <div className="text-xs text-slate-500">Fit packs the dashboard into one screen (no scroll on wide displays); comfortable lets it grow</div>
          </div>
          <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
            {(['fit', 'comfortable'] as const).map((d) => (
              <button key={d} onClick={() => patch({ density: d })}
                className={`px-3 py-1 text-xs capitalize transition ${prefs.density === d ? 'bg-amber-500 text-slate-950' : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'}`}>
                {d === 'fit' ? 'Fit to screen' : 'Comfortable'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
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

        <div className="space-y-3">
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

        {/* Carbon-footprint estimate grid factor (issue #49). Server-side runtime
            setting (AppSetting), not a browser pref, so it changes the estimate for
            every viewer. A location-based ESTIMATE — never touches a cost number. */}
        <div className="space-y-2">
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

        {/* Budget / annual-spend target (issue #46). A positive dollar target,
            tracked on the dashboard's budget card (spent so far vs a projected
            end-of-year total). Calendar-year window. Blank clears it. */}
        <div className="space-y-2">
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

        {/* Charts shown & order (Phase D, #96): this now edits the SERVER layout
            (per account, persisted across browsers/devices) rather than the
            localStorage prefs. Toggling visibility / moving a chart PUTs the
            change back through the layout hook. We show a skeleton while it
            loads so the list isn't a flash of the default order. The per-chart
            series/type/axes customization still lives on the dashboard chart's
            Customize button (also server-backed now). */}
        <div>
          <div className="text-sm font-medium text-slate-200">Charts shown &amp; order</div>
          <div className="mb-2 text-xs text-slate-500">Toggle visibility and reorder the dashboard charts (customize each chart&apos;s series, type, and axes from its <span className="text-slate-300">Customize</span> button on the dashboard). Saved to your account.</div>
          {layoutLoading || !layout ? (
            <div className="text-xs text-slate-500">Loading…</div>
          ) : (
            <ul className="space-y-1.5">
              {layout.order.map((id, i) => {
                const spec = SPEC_BY_ID[id];
                if (!spec) return null;
                const on = layout.widgetConfig[id]?.visible;
                const move = (delta: number) => {
                  const next = [...layout.order];
                  const j = i + delta;
                  if (j < 0 || j >= next.length) return;
                  [next[i], next[j]] = [next[j], next[i]];
                  reorder(next);
                };
                return (
                  <li key={id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-800/70 bg-slate-800/30 px-3 py-1.5">
                    <button onClick={() => updateLayoutChart(id, { visible: !on })}
                      className={`flex items-center gap-2 text-sm ${on ? 'text-slate-100' : 'text-slate-500'}`}>
                      <span className={`inline-block h-3 w-3 rounded-full border ${on ? 'border-amber-500 bg-amber-500' : 'border-slate-600'}`} />
                      {spec.title}
                    </button>
                    <div className="flex items-center gap-1">
                      <button onClick={() => move(-1)} disabled={i === 0} title="Move up"
                        className="rounded border border-slate-700/70 bg-slate-800/40 px-1.5 py-0.5 text-slate-300 transition hover:bg-slate-700 disabled:opacity-30">↑</button>
                      <button onClick={() => move(1)} disabled={i === layout.order.length - 1} title="Move down"
                        className="rounded border border-slate-700/70 bg-slate-800/40 px-1.5 py-0.5 text-slate-300 transition hover:bg-slate-700 disabled:opacity-30">↓</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <button onClick={reset} className="btn border border-slate-700/70 bg-slate-800/40 text-xs text-slate-300 hover:bg-slate-700">
          Reset display settings to defaults
        </button>
      </section>

      {/* Automation */}
      <section className="card space-y-4">
        <h2 className="text-lg font-semibold text-slate-100">Automation</h2>
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

        <div className="border-t border-slate-800 pt-4">
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

          {/* Anomaly alert on a flagged new bill (issue #45). OFF by default;
              reuses the configured channel above and only fires when a scheduled
              scrape brings in a bill whose weather-normalized usage or all-in rate
              is well outside its robust trailing baseline (at most once per bill). */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-800 pt-3">
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
      </section>

      {/* Account & data */}
      <section className="card space-y-3">
        <h2 className="text-lg font-semibold text-slate-100">Account &amp; data</h2>
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

        <div className="border-t border-slate-800 pt-4">
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

        <div className="border-t border-slate-800 pt-4">
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

        <div className="border-t border-slate-800 pt-4">
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
      </section>

      {/* About */}
      <section className="card">
        <h2 className="text-lg font-semibold text-slate-100">About</h2>
        <div className="mt-3 flex items-center gap-2 text-sm">
          <span className="text-slate-500">Version</span>
          <span className="font-mono text-slate-200">v{process.env.NEXT_PUBLIC_APP_VERSION || 'dev'}</span>
        </div>
      </section>

      {/* National Grid logins */}
      <NgLoginsSection />

      {/* Recent runs */}
      <section className="card">
        <h2 className="mb-3 text-lg font-semibold text-slate-100">Recent checks</h2>
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
      </section>
    </div>
  );
}
