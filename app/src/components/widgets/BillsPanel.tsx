'use client';

// Bills rail as a PLACEABLE panel widget (Phase E, issue #73; RFC §3.3: "the
// bills list becomes a panel/tool-category widget"). The markup is lifted
// VERBATIM from the bills rail that used to live inline in Dashboard.tsx — same
// `.card !p-0`, the sticky table header, the internal-scroll body, and the
// range-scoped export footer — so the default dashboard renders identically
// (acceptance #1). The only change is that it's now a registered widget the RGL
// grid places, instead of a hardcoded right-rail column.
//
// It fills its grid cell (h-full + internal overflow) so it stretches to the
// cockpit height exactly like the old `align stretch` rail did, and scrolls
// internally so the page stays put in fit mode.

import { dateLabel, usd } from '@/lib/format';
import type { Bill } from '@/components/useDashboardData';

export interface BillsPanelData {
  // The bills already filtered to the on-screen range (the host applies the
  // range filter, as Dashboard did) — the rail shows the in-range count + rows.
  rangedBills: Bill[];
  currencyDecimals: number;
  // The range-scoped export query fragments (CSV `&from=…&to=…&accountId=…` and
  // the PDF `?from=…&to=…&accountId=…`), built by the host exactly as before so
  // a download matches what's visible.
  csvScope: string;
  pdfScope: string;
}

export function BillsPanel({ data }: { data: BillsPanelData }) {
  const { rangedBills, currencyDecimals: dp, csvScope, pdfScope } = data;
  return (
    <div className="card flex h-full min-h-0 flex-col !p-0">
      <div className="flex shrink-0 items-center justify-between border-b border-slate-800/70 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-100">Bills ({rangedBills.length})</h3>
        <span className="text-[11px] text-slate-500">in range</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-slate-900/95 backdrop-blur">
            <tr className="text-left text-[11px] uppercase tracking-wide text-slate-500">
              <th className="py-2 pr-2">Statement</th>
              <th className="py-2 pr-2">Period</th>
              <th className="py-2 pl-2 text-right">Amount</th>
              <th className="py-2 pl-2 text-right">PDF</th>
            </tr>
          </thead>
          <tbody>
            {rangedBills.map((b) => (
              <tr key={b.statementDate} className="border-t border-slate-800/70">
                <td className="py-1.5 pr-2 font-medium text-slate-200">{dateLabel(b.statementDate)}</td>
                <td className="py-1.5 pr-2 text-xs text-slate-400">
                  {b.periodFrom ? `${dateLabel(b.periodFrom)} – ${dateLabel(b.periodTo)}` : '—'}
                </td>
                <td className="py-1.5 pl-2 text-right text-slate-200">{usd(b.currentCharges, dp)}</td>
                <td className="py-1.5 pl-2 text-right">
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
            {rangedBills.length === 0 && (
              <tr><td className="py-3 text-slate-500" colSpan={4}>No bills in this range.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {/* Range-scoped exports live with the bills they download. */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-slate-800/70 px-4 py-2 text-xs">
        <span className="text-slate-500">Export range:</span>
        <a className="text-amber-400 hover:text-amber-300" href={`/api/export?dataset=series${csvScope}`} download>CSV series</a>
        <span className="text-slate-700">·</span>
        <a className="text-amber-400 hover:text-amber-300" href={`/api/export?dataset=bills${csvScope}`} download>CSV bills</a>
        <span className="text-slate-700">·</span>
        <a className="text-amber-400 hover:text-amber-300" href={`/api/export/pdfs${pdfScope}`} download>PDFs</a>
      </div>
    </div>
  );
}
