import { describe, expect, it } from 'vitest';
import { errMessage } from '../src/lib/ngrid/errMessage';

// Hand-calculated cases pinning errMessage to the EXACT output the inline
// `String(err?.message || err).slice(0, max)` sites produced, now that it accepts
// `unknown`. Each expectation is worked out by hand, not snapshotted.
describe('errMessage (hand-calculated)', () => {
  it("uses an Error's message", () => {
    // new Error('boom').message === 'boom' (truthy) → String('boom') = 'boom'.
    expect(errMessage(new Error('boom'))).toBe('boom');
  });

  it('uses a plain {message} object', () => {
    expect(errMessage({ message: 'nope' })).toBe('nope');
  });

  it('stringifies a bare string error (no .message)', () => {
    // 'oops'?.message === undefined → || 'oops' → String('oops') = 'oops'.
    expect(errMessage('oops')).toBe('oops');
  });

  it('falls back to the value itself when .message is empty (falsy)', () => {
    // ''  is falsy → `'' || err` yields the Error object → String(Error) = 'Error: ...'.
    // An Error with an empty message stringifies to just 'Error'.
    expect(errMessage(new Error(''))).toBe('Error');
    // A plain {message:''} object → '' || {message:''} → String({}) = '[object Object]'.
    expect(errMessage({ message: '' })).toBe('[object Object]');
  });

  it('handles null and undefined', () => {
    // null?.message → undefined → || null → null → String(null) = 'null'.
    expect(errMessage(null)).toBe('null');
    expect(errMessage(undefined)).toBe('undefined');
  });

  it('handles a number (no .message)', () => {
    // (42)?.message === undefined → || 42 → String(42) = '42'.
    expect(errMessage(42)).toBe('42');
  });

  it('truncates to the default max of 200 chars', () => {
    const long = 'x'.repeat(500);
    const out = errMessage(new Error(long));
    expect(out).toHaveLength(200);
    expect(out).toBe('x'.repeat(200));
  });

  it('honors an explicit max (e.g. 500 for the ScrapeRun message)', () => {
    const long = 'y'.repeat(700);
    const out = errMessage(new Error(long), 500);
    expect(out).toHaveLength(500);
    expect(out).toBe('y'.repeat(500));
  });

  it('does not truncate a message shorter than max', () => {
    expect(errMessage(new Error('short'), 500)).toBe('short');
  });

  it('ignores a non-string .message (falls through to String(err))', () => {
    // { message: 123 } → 123 is truthy → but it is not the string branch in the
    // helper; the original `err?.message || err` would yield 123 → String(123)='123'.
    // The helper's `|| err` path: (obj).message = 123 (truthy) → String(123) = '123'.
    expect(errMessage({ message: 123 })).toBe('123');
  });
});
