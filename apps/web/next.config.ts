import type { NextConfig } from 'next';
import path from 'node:path';

const repoRoot = new URL('../..', import.meta.url).pathname;

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@resuto/ui', '@resuto/contracts'],
  outputFileTracingRoot: repoRoot,
  // The contracts package ships CommonJS for Node consumers (API, worker, MCP).
  // The web app compiles its TypeScript source instead, so dev-mode React Refresh
  // works and pages never depend on a stale dist/ build.
  webpack(config) {
    config.resolve.alias = { ...config.resolve.alias, '@resuto/contracts$': path.join(repoRoot, 'packages/contracts/src/index.ts') };
    return config;
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self), microphone=()' },
      ],
    }];
  },
};
export default config;
