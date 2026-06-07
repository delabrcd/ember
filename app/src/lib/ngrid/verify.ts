// Cross-validate the data we use for calculations against the actual bill PDFs
// (the authoritative source). For every stored bill we re-parse its PDF and
// assert the API-sourced numbers (bill total, usage) match it, plus internal
// consistency of the bill itself. This is the guardrail against trusting a
// plausible-but-wrong API value.
import fs from 'fs';
import { prisma } from '@/lib/db';
import { extractPdfText, parseBillDetail } from './parsePdf';
import { ymFromDate, isoDate } from '@/lib/ym';

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}
export interface BillReport {
  statementDate: string;
  ok: boolean;
  checks: Check[];
}
export interface VerifyReport {
  ok: boolean;
  total: number;
  failed: number;
  bills: BillReport[];
}

const close = (a: number | null | undefined, b: number | null | undefined, tol = 0.011): boolean =>
  a != null && b != null && Math.abs(a - b) <= tol;

export async function verifyAll(): Promise<VerifyReport> {
  const account = await prisma.account.findFirst({ orderBy: { id: 'asc' } });
  if (!account) return { ok: false, total: 0, failed: 0, bills: [] };

  const bills = await prisma.bill.findMany({ where: { accountId: account.id }, orderBy: { statementDate: 'desc' } });
  const reports: BillReport[] = [];

  for (const b of bills) {
    const sd = isoDate(b.statementDate);
    const ym = ymFromDate(b.statementDate);
    const checks: Check[] = [];
    const push = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

    if (!b.pdfPath || !fs.existsSync(b.pdfPath)) {
      reports.push({ statementDate: sd, ok: false, checks: [{ name: 'pdf-present', ok: false, detail: 'missing PDF' }] });
      continue;
    }
    const text = await extractPdfText(b.pdfPath);
    if (!text) {
      reports.push({ statementDate: sd, ok: false, checks: [{ name: 'pdf-readable', ok: false }] });
      continue;
    }
    const d = parseBillDetail(text);

    // ---- the number we use for cost analysis (stored currentCharges) == the
    // bill's "Total Current Charges" ----
    const storedCost = b.currentCharges ?? b.totalDueAmount;
    push('period charges: stored == PDF', close(storedCost, d.currentCharges), `stored $${storedCost} vs PDF $${d.currentCharges}`);

    // ---- the API's statement "Amount Due" reconciles as current charges +
    // carried-over balance (explains any difference from the period charges) ----
    push(
      'API amount due == current charges + balance forward',
      close(b.totalDueAmount, (d.currentCharges ?? 0) + (d.balanceForward ?? 0)),
      `API $${b.totalDueAmount} vs PDF $${d.currentCharges} + carryover $${d.balanceForward ?? 0}`
    );

    const [kwh, therms] = await Promise.all([
      prisma.usage.findUnique({ where: { accountId_usageType_periodYearMonth: { accountId: account.id, usageType: 'TOTAL_KWH', periodYearMonth: ym } } }),
      prisma.usage.findUnique({ where: { accountId_usageType_periodYearMonth: { accountId: account.id, usageType: 'THERMS', periodYearMonth: ym } } }),
    ]);
    if (d.electric.usage != null) push('electric usage: API == PDF', close(kwh?.quantity, d.electric.usage, 0.5), `API ${kwh?.quantity} vs PDF ${d.electric.usage} kWh`);
    if (d.gas.usage != null) push('gas usage: API == PDF', close(therms?.quantity, d.gas.usage, 0.5), `API ${therms?.quantity} vs PDF ${d.gas.usage} therms`);

    // ---- the bill is internally consistent (catches a bad parse) ----
    if (d.electric.serviceTotal != null) push('electric supply+delivery == service total', close((d.electric.supply ?? 0) + (d.electric.delivery ?? 0), d.electric.serviceTotal));
    if (d.gas.serviceTotal != null) push('gas supply+delivery == service total', close((d.gas.supply ?? 0) + (d.gas.delivery ?? 0), d.gas.serviceTotal));
    if (d.summaryDelivery != null) push('delivery column reconciles', close((d.electric.delivery ?? 0) + (d.gas.delivery ?? 0), d.summaryDelivery));
    if (d.summarySupply != null) push('supply column reconciles', close((d.electric.supply ?? 0) + (d.gas.supply ?? 0), d.summarySupply));
    if (d.electric.serviceTotal != null && d.gas.serviceTotal != null)
      push('fuels + other == current charges', close(d.electric.serviceTotal + d.gas.serviceTotal + (d.otherCharges ?? 0), d.currentCharges));

    // ---- stored cost rows match a fresh parse (no storage drift) ----
    const costs = await prisma.cost.findMany({ where: { accountId: account.id, periodYearMonth: ym } });
    const cmp = (fuel: string, kind: string, pdf: number | null) => {
      if (pdf == null) return;
      const row = costs.find((c) => c.fuelType === fuel && c.kind === kind);
      push(`DB ${fuel.toLowerCase()} ${kind.toLowerCase()} == PDF`, close(row?.amount, pdf), `DB $${row?.amount} vs PDF $${pdf}`);
    };
    cmp('ELECTRIC', 'SUPPLY', d.electric.supply);
    cmp('ELECTRIC', 'DELIVERY', d.electric.delivery);
    cmp('GAS', 'SUPPLY', d.gas.supply);
    cmp('GAS', 'DELIVERY', d.gas.delivery);

    reports.push({ statementDate: sd, ok: checks.every((c) => c.ok), checks });
  }

  const failed = reports.filter((r) => !r.ok).length;
  return { ok: failed === 0, total: reports.length, failed, bills: reports };
}
