// Extract charges from a National Grid bill PDF. The PDF is the authoritative
// source (the actual bill), so we parse it richly and cross-check the API data
// against it. Text comes from `pdftotext -layout` (poppler-utils).
//
// parseBillDetail() is a PURE function of the extracted text — unit-tested with
// hand-calculated fixtures. extractPdfText() is the only impure part.
import { execFile } from 'child_process';
import { promisify } from 'util';

const exec = promisify(execFile);

export interface FuelDetail {
  supply: number | null; // "Total Electricity/Gas Supply"
  delivery: number | null; // "Total Electricity/Gas Delivery"
  serviceTotal: number | null; // "Electric/Gas Service" summary-row total
  usage: number | null; // kWh (electric) or therms (gas), from the supply line
}

export interface BillDetail {
  currentCharges: number | null; // "Total Current Charges" — THIS period's energy cost
  balanceForward: number | null; // carried-over unpaid balance (null if none)
  amountDue: number | null; // statement "Amount Due" = currentCharges + balanceForward
  summaryDelivery: number | null; // delivery column of the Total Current Charges row
  summarySupply: number | null; // supply column of that row
  otherCharges: number | null; // currentCharges - delivery - supply
  electric: FuelDetail;
  gas: FuelDetail;
}

const MONEY = '\\$?\\s*(-?[\\d,]+\\.\\d{2})';
const num = (s: string | undefined): number | null => (s == null ? null : parseFloat(s.replace(/,/g, '')));

function grab(text: string, label: RegExp): number | null {
  const m = text.match(label);
  return m ? num(m[1]) : null;
}

// Every "[-]$ 123.45" money token on a line, in order, signs preserved.
function moneyTokens(line: string): number[] {
  const out: number[] = [];
  const re = /(-?)\s*\$?\s*(-?[\d,]+\.\d{2})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    const sign = m[1] === '-' ? -1 : 1;
    out.push(sign * parseFloat(m[2].replace(/,/g, '')));
  }
  return out;
}

function lineWith(text: string, re: RegExp): string | null {
  for (const line of text.split('\n')) if (re.test(line)) return line;
  return null;
}

export function parseBillDetail(text: string): BillDetail {
  // Per-fuel supply/delivery from the unambiguous "Detail of Current Charges" totals.
  const electricSupply = grab(text, new RegExp(`Total\\s+Electric(?:ity)?\\s+Supply\\s+${MONEY}`, 'i'));
  const electricDelivery = grab(text, new RegExp(`Total\\s+Electric(?:ity)?\\s+Delivery\\s+${MONEY}`, 'i'));
  const gasSupply = grab(text, new RegExp(`Total\\s+Gas\\s+Supply\\s+${MONEY}`, 'i'));
  const gasDelivery = grab(text, new RegExp(`Total\\s+Gas\\s+Delivery\\s+${MONEY}`, 'i'));

  // Usage from the supply commodity line: "Electricity Supply 0.069 x 509 kWh".
  const electricUsage = num(text.match(/Electricity Supply\s+[\d.]+\s*x\s*([\d,]+)\s*kWh/i)?.[1]);
  const gasUsage = num(text.match(/Gas Supply\s+[\d.]+\s*x\s*([\d,]+)\s*therms?/i)?.[1]);

  // Summary rows: "Electric Service  <delivery>  <supply>  <total>".
  const eRow = lineWith(text, /Electric Service\s+-?[\d,]+\.\d{2}/i);
  const gRow = lineWith(text, /Gas Service\s+-?[\d,]+\.\d{2}/i);
  const eTokens = eRow ? moneyTokens(eRow) : [];
  const gTokens = gRow ? moneyTokens(gRow) : [];

  // "Total Current Charges" row: delivery, supply, …, current-charges total.
  // This is the period's actual energy cost (NOT the statement Amount Due, which
  // also includes any carried-over balance).
  const totalRow = lineWith(text, /Total Current Charges/i);
  const tTokens = totalRow ? moneyTokens(totalRow) : [];
  const summaryDelivery = tTokens.length ? tTokens[0] : null;
  const summarySupply = tTokens.length > 1 ? tTokens[1] : null;
  const currentCharges = tTokens.length ? tTokens[tTokens.length - 1] : null;
  const otherCharges =
    currentCharges != null && summaryDelivery != null && summarySupply != null
      ? Math.round((currentCharges - summaryDelivery - summarySupply) * 100) / 100
      : null;

  // Carried-over unpaid balance, if any (absent on a paid-in-full account).
  const balanceForward = grab(text, /Balance Forward\s+(-?[\d,]+\.\d{2})/i);
  // Statement total owed = this period's charges + any carryover.
  const amountDue = grab(text, /Amount Due\s+\$?\s*(-?[\d,]+\.\d{2})/i) ??
    (currentCharges != null ? Math.round((currentCharges + (balanceForward ?? 0)) * 100) / 100 : null);

  return {
    currentCharges,
    balanceForward,
    amountDue,
    summaryDelivery,
    summarySupply,
    otherCharges,
    electric: {
      supply: electricSupply,
      delivery: electricDelivery,
      serviceTotal: eTokens.length ? eTokens[eTokens.length - 1] : null,
      usage: electricUsage,
    },
    gas: {
      supply: gasSupply,
      delivery: gasDelivery,
      serviceTotal: gTokens.length ? gTokens[gTokens.length - 1] : null,
      usage: gasUsage,
    },
  };
}

export async function extractPdfText(pdfPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec('pdftotext', ['-layout', pdfPath, '-'], { maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

// Used by the scraper. Returns the full parsed detail, or null if nothing read.
export async function parseBillPdf(pdfPath: string): Promise<BillDetail | null> {
  const text = await extractPdfText(pdfPath);
  if (!text) return null;
  const d = parseBillDetail(text);
  const any =
    d.electric.supply != null || d.electric.delivery != null || d.gas.supply != null || d.gas.delivery != null || d.currentCharges != null;
  return any ? d : null;
}
