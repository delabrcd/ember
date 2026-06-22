import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Coverage is REPORT-ONLY (no thresholds → never fails CI; see #160). It is
    // scoped to the pure number/parse/shaping libs — the code standards §1/§2
    // require to be hand-calc tested — and deliberately excludes components, API
    // routes, and impure infra (DB/scraper/scheduler shells) whose coverage would
    // be misleadingly low without a browser/DB. `vitest run --coverage` (the
    // `test:coverage` script) prints a text-summary; CI surfaces it in the job
    // summary. To add a floor later, set `coverage.thresholds` here.
    coverage: {
      provider: 'v8',
      include: ['src/lib/**'],
      reporter: ['text', 'text-summary'],
    },
  },
  // The app's .tsx components use the React 18 AUTOMATIC JSX runtime (Next's
  // default — no `import React`). esbuild defaults to the classic transform
  // (React.createElement, which needs React in scope), so a test that imports a
  // component module (e.g. the widget registry, which wraps ConfigurableChart)
  // would hit `React is not defined`. Match Next's runtime here. Pure-logic tests
  // are unaffected; this only changes how JSX in imported .tsx is compiled.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
