/** @type {import('next').NextConfig} */
const nextConfig = {
  // Not using 'standalone' output: the runtime image keeps full node_modules so the
  // external Playwright + Prisma packages are reliably present for the scraper.
  experimental: {
    // Keep heavy/native packages out of the bundle (Next 14 key).
    serverComponentsExternalPackages: ['playwright', 'playwright-core', '@prisma/client', 'prisma'],
    // Enable src/instrumentation.ts (Next 14.2 needs this opt-in). Used to run the
    // one-time env→NgLogin cutover bootstrap once on server startup.
    instrumentationHook: true,
  },
  webpack: (config, { webpack, nextRuntime }) => {
    // The instrumentation hook is compiled for BOTH the nodejs and edge runtimes.
    // Its (dynamically-imported) bootstrap graph reaches `node:crypto` + Prisma,
    // which the EDGE bundler can't resolve. The hook guards itself to the nodejs
    // runtime at runtime (`NEXT_RUNTIME !== 'nodejs'` → early return), so the edge
    // bundle never executes that path — replace the bootstrap module with an empty
    // stub in the EDGE compilation so webpack stops tracing into it. The nodejs
    // bundle keeps the real implementation untouched.
    if (nextRuntime === 'edge') {
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /lib[\\/]ngrid[\\/]bootstrap(\.ts)?$/,
          new URL('./src/lib/ngrid/bootstrap.edge-stub.ts', import.meta.url).pathname
        )
      );
    }
    return config;
  },
};

export default nextConfig;
