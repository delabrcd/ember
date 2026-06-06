'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { SPEC_BY_ID, type MonthRow } from '@/lib/chartSpec';
import { trailing12AllIn } from '@/lib/series';
import { usePrefs } from '@/lib/prefs';
import {
  buildAccountGroups,
  hasMultipleAccounts,
  resolveSelectedAccountId,
  type AccountSummary,
} from '@/lib/accountSwitcher';
import { ConfigurableChart } from './ConfigurableChart';
import { AccountSwitcher } from './AccountSwitcher';
import { RefreshButton } from './RefreshButton';
import { dateLabel, num, rate, relativeFromNow, usd } from '@/lib/format';

interface Overview {
  empty?: boolean;
  account?: { accountNumber: string; serviceAddress?: string | null; region?: string | null; companyCode?: string | null; fuelTypes?: string[] } | null;
  billCount?: number;
  lifetimeSpend?: number;
  nextBillEstimate?: { point: number; low: number; high: number; basis: string } | null;
  latestBill?: { statementDate: string; totalDueAmount: number | null } | null;
  firstStatement?: string | null;
  schedule?: { predictedNextBillDate: string | null; nextCheckAt: string | null; lastCheckedAt: string | null } | null;
}
interface Bill {
  statementDate: string;
  periodFrom: string | null;
  periodTo: string | null;
  totalDueAmount: number | null;
  hasPdf: boolean;
}

export function Dashboard() {
  const { prefs, patch, loaded } = usePrefs();
  const [ov, setOv] = useState<Overview | null>(null);
  const [rows, setRows] = useState<MonthRow[]>([]);
  const [bills, setBills] = useState<Bill[]>([]);
  const [accounts, setAccounts] = useState<AccountSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // Logins flagged needs_reauth: scraping for them is paused until the operator
  // re-authenticates (in Settings). Existing data keeps showing regardless.
  const [reauthLogins, setReauthLogins] = useState<{ id: number; label: string }[]>([]);

  // The selected account, validated against the live list (a stale persisted id
  // is ignored). null = the default account, which the routes already resolve.
  const selectedAccountId = resolveSelectedAccountId(accounts, prefs.selectedAccountId);
  // Scope every data fetch to the selection; no param = default-account behaviour.
  const scope = selectedAccountId != null ? `?accountId=${selectedAccountId}` : '';

  // The account list is independent of the selection, so fetch it once.
  useEffect(() => {
    fetch('/api/accounts', { cache: 'no-store' })
      .then((r) => r.json())
      .then((a) => setAccounts(a.accounts || []))
      .catch(() => setAccounts([]));
  }, []);

  // Surface any login that needs re-authentication so the operator knows
  // scraping is paused for it (the data below is still its last-known state).
  useEffect(() => {
    fetch('/api/ng-logins', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { logins?: { id: number; label: string; status: string | null }[] }) =>
        setReauthLogins((j.logins || []).filter((l) => l.status === 'needs_reauth').map((l) => ({ id: l.id, label: l.label })))
      )
      .catch(() => setReauthLogins([]));
  }, []);

  const load = useCallback(async () => {
    const [o, s, b] = await Promise.all([
      fetch(`/api/overview${scope}`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`/api/series${scope}`, { cache: 'no-store' }).then((r) => r.json()),
      fetch(`/api/bills${scope}`, { cache: 'no-store' }).then((r) => r.json()),
    ]);
    setOv(o);
    setRows(s.rows || []);
    setBills(b.bills || []);
    setLoading(false);
  }, [scope]);

  // Re-fetch on mount and whenever the selected account changes. Wait until prefs
  // have loaded so the first fetch already reflects a persisted selection rather
  // than firing for the default and then again for the restored account.
  useEffect(() => {
    if (loaded) load();
  }, [load, loaded]);

  const groups = buildAccountGroups(accounts);
  const showSwitcher = hasMultipleAccounts(accounts);
  const empty = !ov || ov.empty || !ov.billCount;
  const lastRow = [...rows].reverse().find((r) => r.elecRateSupply != null || r.gasRateSupply != null);
  const elecAllIn = trailing12AllIn(rows, 'elec');
  const gasAllIn = trailing12AllIn(rows, 'gas');
  const ranged = prefs.rangeMonths > 0 ? rows.slice(-prefs.rangeMonths) : rows;
  const dp = prefs.currencyDecimals;
  const visibleCharts = prefs.order.filter((id) => prefs.charts[id]?.visible && SPEC_BY_ID[id]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-50">National Grid Dashboard</h1>
          {showSwitcher ? (
            <div className="mt-2">
              <AccountSwitcher
                groups={groups}
                selectedId={selectedAccountId}
                onSelect={(id) => patch({ selectedAccountId: id })}
              />
            </div>
          ) : (
            ov?.account && (
              <p className="mt-1 text-sm text-slate-400">
                Account {ov.account.accountNumber}
                {ov.account.serviceAddress ? ` · ${ov.account.serviceAddress}` : ''}
                {ov.account.companyCode ? ` · ${ov.account.companyCode}` : ''}
              </p>
            )
          )}
        </div>
        <div className="flex items-center gap-2">
          <Link href="/settings" className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            Settings
          </Link>
          <RefreshButton onDone={load} />
        </div>
      </header>

      {reauthLogins.length > 0 && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-200">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="font-medium">Not connected — re-authenticate</span>
              <span className="ml-2 text-xs text-rose-200/80">
                {reauthLogins.map((l) => `“${l.label}”`).join(', ')} need re-authentication. The data below is the
                last scraped state; scheduled updates for {reauthLogins.length === 1 ? 'it' : 'them'} are paused.
              </span>
            </div>
            <Link
              href="/settings"
              className="btn border border-rose-700/70 bg-rose-900/40 text-rose-200 hover:bg-rose-800/60"
            >
              Re-authenticate
            </Link>
          </div>
        </div>
      )}

      {ov?.schedule && (
        <div className="flex flex-wrap gap-2">
          <span className="pill">
            Next bill predicted <strong className="text-slate-100">{dateLabel(ov.schedule.predictedNextBillDate)}</strong>
            {ov.schedule.predictedNextBillDate ? ` (${relativeFromNow(ov.schedule.predictedNextBillDate + 'T00:00:00')})` : ''}
          </span>
          <span className="pill">Last checked {relativeFromNow(ov.schedule.lastCheckedAt)}</span>
          <span className="pill">Next auto-check {relativeFromNow(ov.schedule.nextCheckAt)}</span>
        </div>
      )}

      {loading ? (
        <div className="card text-slate-400">Loading…</div>
      ) : empty ? (
        <div className="card">
          <h2 className="text-lg font-semibold text-slate-100">No data yet</h2>
          <p className="mt-1 text-sm text-slate-400">
            Click <span className="text-amber-400">Check for new bills</span> to log in to National Grid and pull your
            full history. The first run downloads every bill and PDF and can take a couple of minutes.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div className="card">
              <div className="card-title">Latest bill</div>
              <div className="stat">{usd(ov?.latestBill?.totalDueAmount, dp)}</div>
              <div className="mt-1 text-xs text-slate-500">{dateLabel(ov?.latestBill?.statementDate)}</div>
            </div>
            <div className="card">
              <div className="card-title">Lifetime spend</div>
              <div className="stat">{usd(ov?.lifetimeSpend, 0)}</div>
              <div className="mt-1 text-xs text-slate-500">across {num(ov?.billCount)} bills</div>
            </div>
            <div className="card">
              <div className="card-title">Electric rate</div>
              <div className="stat">{rate(elecAllIn)}<span className="text-base text-slate-500">/kWh</span></div>
              <div className="mt-1 text-xs text-slate-500">all-in, 12-mo avg · supply {rate(lastRow?.elecRateSupply)}</div>
            </div>
            <div className="card">
              <div className="card-title">Gas rate</div>
              <div className="stat">{rate(gasAllIn, 2)}<span className="text-base text-slate-500">/therm</span></div>
              <div className="mt-1 text-xs text-slate-500">all-in, 12-mo avg · supply {rate(lastRow?.gasRateSupply, 2)}</div>
            </div>
          </div>

          {ov?.nextBillEstimate && (
            <div className="card">
              <div className="card-title">
                Est. next bill <span className="ml-1 rounded bg-slate-800/70 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-slate-400">estimate</span>
              </div>
              <div className="stat">~{usd(ov.nextBillEstimate.point, dp)}</div>
              <div className="mt-1 text-xs text-slate-500">
                range {usd(ov.nextBillEstimate.low, dp)}–{usd(ov.nextBillEstimate.high, dp)} · {ov.nextBillEstimate.basis} · not a real charge
              </div>
            </div>
          )}

          {visibleCharts.length === 0 ? (
            <div className="card text-sm text-slate-400">
              All charts are hidden. Enable them in <Link href="/settings" className="text-amber-400">Settings</Link>.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              {visibleCharts.map((id) => (
                <ConfigurableChart key={id} spec={SPEC_BY_ID[id]} rows={ranged} />
              ))}
            </div>
          )}

          <div className="card">
            <h3 className="mb-3 text-base font-semibold text-slate-100">Bills ({bills.length})</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-2 py-2">Statement</th>
                    <th className="px-2 py-2">Service period</th>
                    <th className="px-2 py-2 text-right">Amount</th>
                    <th className="px-2 py-2 text-right">PDF</th>
                  </tr>
                </thead>
                <tbody>
                  {bills.map((b) => (
                    <tr key={b.statementDate} className="border-t border-slate-800/70">
                      <td className="px-2 py-2 font-medium text-slate-200">{dateLabel(b.statementDate)}</td>
                      <td className="px-2 py-2 text-slate-400">
                        {b.periodFrom ? `${dateLabel(b.periodFrom)} – ${dateLabel(b.periodTo)}` : '—'}
                      </td>
                      <td className="px-2 py-2 text-right text-slate-200">{usd(b.totalDueAmount, dp)}</td>
                      <td className="px-2 py-2 text-right">
                        {b.hasPdf ? (
                          <a className="text-amber-400 hover:text-amber-300" href={`/api/bills/${b.statementDate}/pdf`} target="_blank" rel="noreferrer">
                            View
                          </a>
                        ) : (
                          <span className="text-slate-600">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <footer className="pt-2 text-center text-xs text-slate-600">
        ngrid-dashboard v{process.env.NEXT_PUBLIC_APP_VERSION || 'dev'} · self-hosted · data scraped from your own
        National Grid account · not affiliated with National Grid
      </footer>
    </div>
  );
}
