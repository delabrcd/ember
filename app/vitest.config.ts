import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
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
