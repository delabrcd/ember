import { describe, expect, it } from 'vitest';
import {
  formatProgressLine,
  isRunActive,
  scrapeIndicatorState,
  type ProgressRun,
} from '../src/lib/ngrid/progress';

// Pure helpers for the live scrape-progress indicator — no DB/browser/React.

describe('formatProgressLine', () => {
  it('collapses whitespace and trims', () => {
    expect(formatProgressLine('  downloading   PDF\n12/48  ')).toBe('downloading PDF 12/48');
  });

  it('clamps to 500 chars so a runaway line cannot bloat the row', () => {
    expect(formatProgressLine('x'.repeat(900))).toHaveLength(500);
  });

  it('yields empty string for blank input', () => {
    expect(formatProgressLine('   \n  ')).toBe('');
  });
});

describe('scrapeIndicatorState', () => {
  const run = (over: Partial<ProgressRun>): ProgressRun => ({ id: 1, status: 'RUNNING', ...over });

  it('is idle with no run', () => {
    expect(scrapeIndicatorState(null)).toEqual({ phase: 'idle', text: '', done: true });
    expect(scrapeIndicatorState(undefined).phase).toBe('idle');
  });

  it('running surfaces the latest step and is not done', () => {
    const s = scrapeIndicatorState(run({ status: 'RUNNING', message: 'downloading PDF 12/48' }));
    expect(s).toEqual({ phase: 'running', text: 'downloading PDF 12/48', done: false });
  });

  it('running with no message yet falls back to a starting label', () => {
    expect(scrapeIndicatorState(run({ status: 'RUNNING', message: null }))).toEqual({
      phase: 'running',
      text: 'Starting…',
      done: false,
    });
  });

  it('success carries the final summary and is done', () => {
    const s = scrapeIndicatorState(run({ status: 'SUCCESS', message: '1 account(s): 48 bills (3 new), 3 PDFs fetched' }));
    expect(s.phase).toBe('success');
    expect(s.done).toBe(true);
    expect(s.text).toContain('48 bills');
  });

  it('success with no message falls back to "Up to date"', () => {
    expect(scrapeIndicatorState(run({ status: 'SUCCESS', message: '' })).text).toBe('Up to date');
  });

  it('error surfaces the message and is done', () => {
    const s = scrapeIndicatorState(run({ status: 'ERROR', message: 'login failed' }));
    expect(s).toEqual({ phase: 'error', text: 'login failed', done: true });
  });

  it('error with no message falls back to a generic failure', () => {
    expect(scrapeIndicatorState(run({ status: 'ERROR', message: null })).text).toBe('Scrape failed');
  });
});

describe('isRunActive', () => {
  it('is true only while RUNNING', () => {
    expect(isRunActive({ id: 1, status: 'RUNNING' })).toBe(true);
    expect(isRunActive({ id: 1, status: 'SUCCESS' })).toBe(false);
    expect(isRunActive({ id: 1, status: 'ERROR' })).toBe(false);
    expect(isRunActive(null)).toBe(false);
    expect(isRunActive(undefined)).toBe(false);
  });
});
