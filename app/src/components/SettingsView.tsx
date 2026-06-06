'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CHART_SPECS } from '@/lib/chartSpec';
import { usePrefs } from '@/lib/prefs';
import { dateLabel, relativeFromNow } from '@/lib/format';
import { RefreshButton } from './RefreshButton';

interface ServerSettings {
  schedulerEnabled: boolean;
  schedule: { predictedNextBillDate: string | null; nextCheckAt: string | null; lastCheckedAt: string | null } | null;
  account: { accountNumber: string; serviceAddress?: string | null; region?: string | null; companyCode?: string | null; fuelTypes?: string[] } | null;
  billCount: number;
  firstStatement: string | null;
  latestBill: { statementDate: string; totalDueAmount: number | null } | null;
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

const RANGES: { label: string; value: number }[] = [
  { label: 'All', value: 0 },
  { label: '12 mo', value: 12 },
  { label: '24 mo', value: 24 },
  { label: '36 mo', value: 36 },
];

export function SettingsView() {
  const { prefs, patch, updateChart, reset } = usePrefs();
  const [server, setServer] = useState<ServerSettings | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [savingSched, setSavingSched] = useState(false);
  const [verify, setVerify] = useState<{ ok: boolean; total: number; failed: number; bills: { statementDate: string; ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] }[] } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const runVerify = async () => {
    setVerifying(true);
    setVerify(null);
    const r = await fetch('/api/verify', { cache: 'no-store' }).then((x) => x.json());
    setVerify(r);
    setVerifying(false);
  };

  const loadServer = useCallback(async () => {
    const [s, r] = await Promise.all([
      fetch('/api/settings', { cache: 'no-store' }).then((x) => x.json()),
      fetch('/api/runs', { cache: 'no-store' }).then((x) => x.json()),
    ]);
    setServer(s);
    setRuns(r.runs || []);
  }, []);

  useEffect(() => {
    loadServer();
  }, [loadServer]);

  const setScheduler = async (enabled: boolean) => {
    setSavingSched(true);
    setServer((s) => (s ? { ...s, schedulerEnabled: enabled } : s));
    await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ schedulerEnabled: enabled }) });
    setSavingSched(false);
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
            <div className="text-xs text-slate-500">How much history the charts show</div>
          </div>
          <div className="inline-flex overflow-hidden rounded-lg border border-slate-700">
            {RANGES.map((r) => (
              <button key={r.value} onClick={() => patch({ rangeMonths: r.value })}
                className={`px-3 py-1 text-xs transition ${prefs.rangeMonths === r.value ? 'bg-amber-500 text-slate-950' : 'bg-slate-800/50 text-slate-300 hover:bg-slate-700'}`}>
                {r.label}
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

        <div>
          <div className="text-sm font-medium text-slate-200">Charts shown</div>
          <div className="mb-2 text-xs text-slate-500">Toggle which charts appear on the dashboard (configure each chart from its gear menu)</div>
          <div className="flex flex-wrap gap-2">
            {CHART_SPECS.map((spec) => {
              const on = prefs.charts[spec.id]?.visible;
              return (
                <button key={spec.id} onClick={() => updateChart(spec.id, { visible: !on })}
                  className={`pill ${on ? 'border-amber-500/60 text-amber-300' : 'opacity-60'}`}>
                  {on ? '✓ ' : ''}{spec.title}
                </button>
              );
            })}
          </div>
        </div>

        <button onClick={reset} className="text-xs text-slate-400 underline hover:text-slate-200">Reset display settings to defaults</button>
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
              <a className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700" href="/api/export?dataset=series" download>
                Series
              </a>
              <a className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700" href="/api/export?dataset=bills" download>
                Bills
              </a>
            </div>
          </div>
        </div>

        <div className="border-t border-slate-800 pt-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-slate-200">Data integrity</div>
              <div className="text-xs text-slate-500">Re-parse every bill PDF and cross-check the stored numbers against it.</div>
            </div>
            <button className="btn border border-slate-700/70 bg-slate-800/40 text-slate-200 hover:bg-slate-700" onClick={runVerify} disabled={verifying}>
              {verifying ? 'Verifying…' : 'Verify all bills'}
            </button>
          </div>
          {verify && (
            <div className="mt-3 text-sm">
              {verify.ok ? (
                <p className="text-emerald-400">✓ All {verify.total} bills match their PDFs exactly.</p>
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
