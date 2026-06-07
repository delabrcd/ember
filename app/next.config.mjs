/** @type {import('next').NextConfig} */
const nextConfig = {
  // Not using 'standalone' output: the runtime image keeps full node_modules so the
  // external Playwright + Prisma packages are reliably present for the scraper.
  experimental: {
    // Keep heavy/native packages out of the bundle (Next 14 key).
    serverComponentsExternalPackages: ['playwright', 'playwright-core', '@prisma/client', 'prisma'],
  },
};

export default nextConfig;
