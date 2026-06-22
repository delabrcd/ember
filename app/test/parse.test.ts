import { describe, expect, it } from 'vitest';
import { parseBillDetail } from '../src/lib/ngrid/parsePdf';

// Synthetic bill text mirroring the `pdftotext -layout` output of a real National
// Grid bill. Numbers are chosen so every value is hand-verifiable:
//   electric: delivery 60.00, supply 40.00, usage 500 kWh  -> service total 100.00
//   gas:      delivery 30.00, supply 20.00, usage  50 thm  -> service total  50.00
//   other charges: -2.50      grand total: 147.50  (= 100 + 50 - 2.50)
const BILL = `
SUMMARY OF CURRENT CHARGES
                                            DELIVERY    SUPPLY   OTHER CHARGES/
                                            SERVICES  SERVICES   ADJUSTMENTS        TOTAL
Electric Service                              60.00      40.00                      100.00
Gas Service                                   30.00      20.00                       50.00
Other Charges/Adjustments                                            -0.60           -2.50
Total Current Charges                       $ 90.00    $ 60.00     -$ 2.50         $ 147.50

DETAIL OF CURRENT CHARGES
Electricity Delivery
        Basic Service (not including usage)                                          10.00
        Delivery                       0.10 x 500 kWh                                 50.00
                                            Total Electricity Delivery             $ 60.00
Gas Delivery
        Basic Service Charge                                                         12.00
        Next 47 Therms                 0.36 x 50 therms                              18.00
                                            Total Gas Delivery                     $ 30.00
Supply Services
Electricity Supply
        Electricity Supply             0.08 x 500 kWh                                40.00
                                            Total Electricity Supply               $ 40.00
Gas Supply
        Gas Supply                     0.40 x 50 therms                             20.00
                                            Total Gas Supply                       $ 20.00
`;

describe('parseBillDetail (hand-calculated)', () => {
  const d = parseBillDetail(BILL);

  it('reads per-fuel supply & delivery from the detail totals', () => {
    expect(d.electric.supply).toBe(40.0);
    expect(d.electric.delivery).toBe(60.0);
    expect(d.gas.supply).toBe(20.0);
    expect(d.gas.delivery).toBe(30.0);
  });

  it('reads usage from the supply commodity lines', () => {
    expect(d.electric.usage).toBe(500);
    expect(d.gas.usage).toBe(50);
  });

  it('reads the summary service totals and current charges', () => {
    expect(d.electric.serviceTotal).toBe(100.0);
    expect(d.gas.serviceTotal).toBe(50.0);
    expect(d.summaryDelivery).toBe(90.0);
    expect(d.summarySupply).toBe(60.0);
    expect(d.currentCharges).toBe(147.5);
  });

  it('computes other charges as currentCharges - delivery - supply, preserving sign', () => {
    expect(d.otherCharges).toBe(-2.5); // 147.50 - 90 - 60
  });

  it('has no balance forward on a paid-in-full bill; amount due == current charges', () => {
    expect(d.balanceForward).toBeNull();
    expect(d.amountDue).toBe(147.5);
  });

  it('is internally consistent', () => {
    expect(d.electric.supply! + d.electric.delivery!).toBe(d.electric.serviceTotal); // 40+60=100
    expect(d.gas.supply! + d.gas.delivery!).toBe(d.gas.serviceTotal); // 20+30=50
    expect(d.electric.delivery! + d.gas.delivery!).toBe(d.summaryDelivery); // 60+30=90
    expect(d.electric.supply! + d.gas.supply!).toBe(d.summarySupply); // 40+20=60
    expect(d.electric.serviceTotal! + d.gas.serviceTotal! + d.otherCharges!).toBeCloseTo(d.currentCharges!, 2); // 100+50-2.5
  });
});

describe('parseBillDetail with a carried-over balance (the 2024-08-12 case)', () => {
  // Period charges 205.37; previous balance partly unpaid leaves 2.09 carried
  // forward; statement Amount Due = 205.37 + 2.09 = 207.46.
  const BILL3 = `
Previous Balance                                                                     178.85
Payment Received on AUG 5 ( ACH)                                                  - 176.76
Balance Forward                                                                        2.09
                                                  Amount Due                       $ 207.46
Electric Service                             106.00       85.66                      191.66
Gas Service                                   31.33        4.31                       35.64
Total Current Charges                       $ 137.33     $ 89.97    -$ 21.93        $ 205.37
`;
  const d = parseBillDetail(BILL3);
  it('separates period charges from the statement amount due', () => {
    expect(d.currentCharges).toBe(205.37);
    expect(d.balanceForward).toBe(2.09);
    expect(d.amountDue).toBe(207.46);
  });
  it('reconciles: amount due == current charges + balance forward', () => {
    expect(d.currentCharges! + d.balanceForward!).toBeCloseTo(d.amountDue!, 2); // 205.37 + 2.09 = 207.46
  });
});

describe('parseBillDetail (no "other charges" row -> other = 0)', () => {
  const BILL2 = `
Electric Service                              60.00      40.00                      100.00
Gas Service                                   30.00      20.00                       50.00
Total Current Charges                       $ 90.00    $ 60.00                     $ 150.00
                                            Total Electricity Delivery             $ 60.00
                                            Total Electricity Supply               $ 40.00
                                            Total Gas Delivery                     $ 30.00
                                            Total Gas Supply                       $ 20.00
`;
  it('grand total 150.00, other = 0.00', () => {
    const d = parseBillDetail(BILL2);
    expect(d.amountDue).toBe(150.0);
    expect(d.otherCharges).toBe(0); // 150 - 90 - 60
  });
});

describe('parseBillDetail (no "Amount Due" line + a Balance Forward -> computed fallback)', () => {
  // No explicit "Amount Due" line at all, so amountDue falls through to the
  // computed branch: currentCharges + (balanceForward ?? 0).
  //   currentCharges = 100.00 (last token of the Total Current Charges row)
  //   balanceForward = 25.50  → amountDue = round((100.00 + 25.50)*100)/100 = 125.50
  const BILL_FALLBACK = `
Balance Forward                                                                       25.50
Electric Service                              50.00      30.00                       80.00
Total Current Charges                       $ 50.00    $ 30.00     $ 20.00          $ 100.00
                                            Total Electricity Delivery             $ 50.00
                                            Total Electricity Supply               $ 30.00
`;
  const d = parseBillDetail(BILL_FALLBACK);
  it('computes amountDue = currentCharges + balanceForward when no Amount Due line exists', () => {
    expect(d.currentCharges).toBe(100.0);
    expect(d.balanceForward).toBe(25.5);
    expect(d.amountDue).toBe(125.5); // 100.00 + 25.50, via the computed fallback
  });
  it('still derives otherCharges from the summary row', () => {
    expect(d.otherCharges).toBe(20.0); // 100.00 - 50.00 - 30.00
  });
});

describe('parseBillDetail (negative otherCharges needing rounding)', () => {
  // delivery 90.00, supply 0.10, currentCharges 89.97.
  // otherCharges = currentCharges - delivery - supply = 89.97 - 90.00 - 0.10.
  // In IEEE-754 that is -0.13000000000000114, so the Math.round(...*100)/100
  // guard is load-bearing here: it yields a clean -0.13.
  const BILL_NEG = `
Electric Service                              90.00       0.10                       90.10
Total Current Charges                       $ 90.00    $ 0.10     -$ 0.13           $ 89.97
                                            Total Electricity Delivery             $ 90.00
                                            Total Electricity Supply               $ 0.10
`;
  const d = parseBillDetail(BILL_NEG);
  it('rounds a tiny-float negative to a clean -0.13', () => {
    expect(d.summaryDelivery).toBe(90.0);
    expect(d.summarySupply).toBe(0.1);
    expect(d.currentCharges).toBe(89.97);
    expect(d.otherCharges).toBe(-0.13);
  });
});
