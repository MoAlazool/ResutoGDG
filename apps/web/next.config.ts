import type { NextConfig } from 'next';
import path from 'node:path';
import { buildCsp } from './lib/csp';

const repoRoot = new URL('../..', import.meta.url).pathname;

/**
 * Pages get a per-request nonce policy from middleware.ts (lib/csp.ts, audit PS-17). This static fallback covers
 * responses the middleware does not handle (static files, Next internals); it is compatible with the page policy.
 */
const fallbackCsp = buildCsp({ nonce: null, dev: process.env.NODE_ENV !== 'production',
  apiUrl: process.env.NEXT_PUBLIC_API_URL, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL });

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
    // Static files from public/ (PCL-22, docs/CACHE_POLICY.md). Fonts carry a content hash in their name
    // (scripts/perf/fonts/convert-woff2.py), so they are immutable for a year. Brand and landing images keep stable
    // names that pages reference directly: a day fresh, then revalidated in the background for a week.
    const staticCache = [
      { source: '/fonts/:file*', value: 'public, max-age=31536000, immutable' },
      { source: '/brand/:file*', value: 'public, max-age=86400, stale-while-revalidate=604800' },
      { source: '/landing/:file*', value: 'public, max-age=86400, stale-while-revalidate=604800' },
    ].map(({ source, value }) => ({ source, headers: [{ key: 'Cache-Control', value }] }));
    return [...staticCache, {
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(self), geolocation=(self), microphone=()' },
        { key: 'Content-Security-Policy', value: fallbackCsp },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
      ],
    }];
  },
};
export default config;
