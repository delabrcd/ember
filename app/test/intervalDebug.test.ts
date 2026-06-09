import { describe, expect, it } from 'vitest';
import {
  truncateForDebug,
  summarizeGqlResponse,
  summarizeGqlRequest,
} from '../src/lib/ngrid/intervalDebug';

describe('truncateForDebug', () => {
  it('caps arrays to maxArray items with a "…N more" marker', () => {
    const out = truncateForDebug([1, 2, 3, 4, 5], 3) as unknown[];
    expect(out).toEqual([1, 2, 3, '…2 more']);
  });

  it('keeps arrays shorter than the cap unchanged (no marker)', () => {
    expect(truncateForDebug([1, 2], 3)).toEqual([1, 2]);
  });

  it('truncates long strings to maxStr chars with a length suffix', () => {
    const long = 'x'.repeat(10);
    expect(truncateForDebug(long, 3, 4)).toBe('xxxx…(10 chars)');
  });

  it('leaves short strings unchanged', () => {
    expect(truncateForDebug('hi', 3, 400)).toBe('hi');
  });

  it('recurses into nested objects and arrays', () => {
    const out = truncateForDebug(
      { nodes: [{ s: 'abcdef' }, { s: 'g' }, { s: 'h' }, { s: 'i' }] },
      2,
      3
    );
    expect(out).toEqual({
      nodes: [{ s: 'abc…(6 chars)' }, { s: 'g' }, '…2 more'],
    });
  });

  it('passes through primitives untouched', () => {
    expect(truncateForDebug(42)).toBe(42);
    expect(truncateForDebug(true)).toBe(true);
    expect(truncateForDebug(null)).toBe(null);
  });
});

describe('summarizeGqlResponse', () => {
  it('returns the top-level data keys and a truncated sample', () => {
    const data = { energyUsages: { nodes: [1, 2, 3, 4] }, weather: [] };
    const out = summarizeGqlResponse('https://x/api/foo-gql', data);
    expect(out.url).toBe('https://x/api/foo-gql');
    expect(out.keys).toEqual(['energyUsages', 'weather']);
    expect(out.sample).toEqual({
      energyUsages: { nodes: [1, 2, 3, '…1 more'] },
      weather: [],
    });
  });
});

describe('summarizeGqlRequest', () => {
  it('extracts operationName and (truncated) variables', () => {
    const body = JSON.stringify({
      operationName: 'MySmartEnergy',
      query: 'query MySmartEnergy { intervals }',
      variables: { accountNumber: '123', series: [1, 2, 3, 4, 5] },
    });
    const out = summarizeGqlRequest('https://x/api/mse-gql', body);
    expect(out).toEqual({
      url: 'https://x/api/mse-gql',
      operationName: 'MySmartEnergy',
      variables: { accountNumber: '123', series: [1, 2, 3, '…2 more'] },
    });
  });

  it('handles a gql body with variables but no operationName', () => {
    const body = JSON.stringify({ variables: { from: 200001 } });
    const out = summarizeGqlRequest('https://x/api/foo-gql', body);
    expect(out).toEqual({ url: 'https://x/api/foo-gql', variables: { from: 200001 } });
  });

  it('returns null for a non-JSON body', () => {
    expect(summarizeGqlRequest('https://x/api/foo-gql', 'not json{')).toBeNull();
  });

  it('returns null for JSON that is not a GraphQL op', () => {
    expect(summarizeGqlRequest('https://x/api/foo-gql', JSON.stringify({ foo: 1 }))).toBeNull();
  });

  it('returns null for an empty body', () => {
    expect(summarizeGqlRequest('https://x/api/foo-gql', '')).toBeNull();
  });
});
