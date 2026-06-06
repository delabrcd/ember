import { describe, expect, it } from 'vitest';
import type { MonthRow } from '../src/lib/chartSpec';
import { billsToCsv, seriesToCsv, toCsv, type BillCsvRow } from '../src/lib/csv';

describe('toCsv (hand-calculated)', () => {
  it('emits a header row then data rows, CRLF-delimited', () => {
    const csv = toCsv(['a', 'b'], [[1, 2], [3, 4]]);
    expect(csv).toBe('a,b\r\n1,2\r\n3,4');
  });

  it('renders null/undefined as empty and numbers as-is', () => {
    const csv = toCsv(['x', 'y', 'z'], [[0, null, undefined]]);
    expect(csv).toBe('x,y,z\r\n0,,');
  });

  it('quotes fields containing a comma', () => {
    const csv = toCsv(['v'], [['a,b']]);
    expect(csv).toBe('v\r\n"a,b"');
  });

  it('quotes and doubles an internal double-quote', () => {
    const csv = toCsv(['v'], [['she said "hi"']]);
    expect(csv).toBe('v\r\n"she said ""hi"""');
  });

  it('quotes fields containing a newline (LF or CR)', () => {
    expect(toCsv(['v'], [['line1\nline2']])).toBe('v\r\n"line1\nline2"');
    expect(toCsv(['v'], [['line1\rline2']])).toBe('v\r\n"line1\rline2"');
  });

  it('leaves a plain string unquoted', () => {
    expect(toCsv(['v'], [['plain']])).toBe('v\r\nplain');
  });
});

function row(over: Partial<MonthRow>): MonthRow {
  return {
    ym: 202601,
    label: '2026-01',
    kwh: null,
    therms: null,
    elecSupply: null,
    gasSupply: null,
    elecDelivery: null,
    gasDelivery: null,
    elecBill: null,
    gasBill: null,
    elecRateSupply: null,
    gasRateSupply: null,
    elecRateAllIn: null,
    gasRateAllIn: null,
    avgTemp: null,
    billTotal: null,
    hdd: null,
    cdd: null,
    kwhPerDegreeDay: null,
    thermsPerHdd: null,
    ...over,
  };
}

describe('seriesToCsv (hand-calculated)', () => {
  it('orders columns and sources currentCharges from billTotal', () => {
    const csv = seriesToCsv([
      row({
        label: '2026-01',
        kwh: 500,
        therms: 50,
        elecSupply: 40,
        gasSupply: 20,
        elecDelivery: 60,
        gasDelivery: 30,
        billTotal: 147.5,
        elecRateSupply: 0.08,
        gasRateSupply: 0.4,
        elecRateAllIn: 0.2,
        gasRateAllIn: 1,
        avgTemp: 25,
        hdd: 1000,
        cdd: 250,
      }),
    ]);
    const [header, line] = csv.split('\r\n');
    expect(header).toBe(
      'month,kWh,therms,elecSupply,gasSupply,elecDelivery,gasDelivery,currentCharges,elecRateSupply,gasRateSupply,elecRateAllIn,gasRateAllIn,avgTemp,hdd,cdd',
    );
    // currentCharges is the 8th field — the 147.5 period energy cost (billTotal).
    expect(line).toBe('2026-01,500,50,40,20,60,30,147.5,0.08,0.4,0.2,1,25,1000,250');
  });

  it('renders missing values as empty fields', () => {
    const csv = seriesToCsv([row({ label: '2026-02', kwh: 300 })]);
    const lines = csv.split('\r\n');
    expect(lines[1]).toBe('2026-02,300,,,,,,,,,,,,,');
  });

  it('emits only the header for no rows', () => {
    expect(seriesToCsv([])).toBe(
      'month,kWh,therms,elecSupply,gasSupply,elecDelivery,gasDelivery,currentCharges,elecRateSupply,gasRateSupply,elecRateAllIn,gasRateAllIn,avgTemp,hdd,cdd',
    );
  });
});

describe('billsToCsv (hand-calculated)', () => {
  const bills: BillCsvRow[] = [
    {
      statementDate: '2026-01-15',
      periodFrom: '2025-12-14',
      periodTo: '2026-01-13',
      totalDueAmount: 205.37, // currentCharges (period energy cost)
      amountDue: 207.46, // statement amount due, with carryover
      hasPdf: true,
    },
    {
      statementDate: '2025-12-15',
      periodFrom: null,
      periodTo: null,
      totalDueAmount: null,
      amountDue: null,
      hasPdf: false,
    },
  ];

  it('orders columns, labels currentCharges, and keeps amountDue distinct', () => {
    const csv = billsToCsv(bills);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('statementDate,periodFrom,periodTo,currentCharges,amountDue,hasPdf');
    // currentCharges 205.37 != amountDue 207.46 — they are kept separate.
    expect(lines[1]).toBe('2026-01-15,2025-12-14,2026-01-13,205.37,207.46,true');
    // Missing period/amounts render empty; hasPdf is a literal boolean string.
    expect(lines[2]).toBe('2025-12-15,,,,,false');
  });

  it('emits only the header for no bills', () => {
    expect(billsToCsv([])).toBe('statementDate,periodFrom,periodTo,currentCharges,amountDue,hasPdf');
  });
});
