import { describe, expect, it } from 'vitest';
import { extractAccountLinks, buildNavUrl } from '../src/lib/ngrid/accounts';

describe('extractAccountLinks (pure)', () => {
  it('returns just the default link when no list is present', () => {
    expect(extractAccountLinks([], 'abc123')).toEqual(['abc123']);
    expect(extractAccountLinks([{}], 'abc123')).toEqual(['abc123']);
  });

  it('is empty when there is neither a default nor a discovered list', () => {
    expect(extractAccountLinks([{ unrelated: 1 }])).toEqual([]);
  });

  it('pulls links from an `accounts.nodes` connection and keeps the default first', () => {
    const data = {
      accounts: { nodes: [{ accountLink: 'aaa' }, { accountLink: 'bbb' }, { accountLink: 'ccc' }] },
    };
    // default 'bbb' is the landed-on account; it must lead, then the rest in order.
    expect(extractAccountLinks([data], 'bbb')).toEqual(['bbb', 'aaa', 'ccc']);
  });

  it('reads a plain array under OpowerAccount and dedupes against the default', () => {
    const data = { OpowerAccount: [{ accountLink: 'one' }, { accountLink: 'two' }] };
    expect(extractAccountLinks([data], 'one')).toEqual(['one', 'two']);
  });

  it('reads accounts nested under `user` (account-switcher payload)', () => {
    const data = { user: { accounts: { nodes: [{ accountLink: 'p1' }, { accountLink: 'p2' }] } } };
    expect(extractAccountLinks([data])).toEqual(['p1', 'p2']);
  });

  it('accepts a single account object (the current account) not in an array', () => {
    const data = { billingAccount: { accountLink: 'solo' } };
    // billingAccount isn't a list key here; OpowerAccount single-object form is.
    const single = { OpowerAccount: { accountLink: 'solo' } };
    expect(extractAccountLinks([single])).toEqual(['solo']);
    expect(extractAccountLinks([data])).toEqual([]); // billingAccount is per-account detail, not the list
  });

  it('dedupes links that appear across multiple captured payloads', () => {
    const p1 = { accounts: { nodes: [{ accountLink: 'x' }, { accountLink: 'y' }] } };
    const p2 = { OpowerAccount: [{ accountLink: 'y' }, { accountLink: 'z' }] };
    expect(extractAccountLinks([p1, p2], 'x')).toEqual(['x', 'y', 'z']);
  });

  it('trims whitespace and ignores blank/missing links', () => {
    const data = { accounts: [{ accountLink: '  a  ' }, { accountLink: '' }, { foo: 1 }, { link: 'b' }] };
    expect(extractAccountLinks([data])).toEqual(['a', 'b']);
  });
});

describe('buildNavUrl (pure)', () => {
  const BASE = 'https://myaccount.nationalgrid.com';

  it('omits the query when there is no accountLink', () => {
    expect(buildNavUrl(BASE, '/dashboard')).toBe('https://myaccount.nationalgrid.com/dashboard');
    expect(buildNavUrl(BASE, '/dashboard', undefined)).toBe('https://myaccount.nationalgrid.com/dashboard');
  });

  it('appends the accountLink query param', () => {
    expect(buildNavUrl(BASE, '/bill-history', 'abc123')).toBe(
      'https://myaccount.nationalgrid.com/bill-history?accountLink=abc123'
    );
  });

  it('url-encodes a link with special characters', () => {
    expect(buildNavUrl(BASE, '/energy-usage', 'a b&c')).toBe(
      'https://myaccount.nationalgrid.com/energy-usage?accountLink=a%20b%26c'
    );
  });
});
