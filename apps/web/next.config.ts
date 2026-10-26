import type { NextConfig } from 'next';
import path from 'node:path';
import { buildCsp } from './lib/csp';
import { insightsRedirects } from './lib/insights';
import { navRedirects } from './lib/nav-redirects';

const repoRoot = new URL('../..', import.meta.url).pathname;

/**
 * Pages get a per-request nonce policy from middleware.ts (lib/csp.ts, audit PS-17). This static fallback covers
 * responses the middleware does not handle (static files, Next internals); it is compatible with the page policy.
 */
// frameSelf: when a page response carries both this and the page policy, the stricter page policy decides (guest pages
// keep frame-src 'none'); staff pages may frame the Studio canvas (21-STUDIO).
const fallbackCsp = buildCsp({ nonce: null, dev: process.env.NODE_ENV !== 'production',
  apiUrl: process.env.NEXT_PUBLIC_API_URL, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, frameSelf: true });
/** The Studio canvas (21-STUDIO) is framed by the Studio: same-origin framing only, for this one page. */
const canvasCsp = buildCsp({ nonce: null, dev: process.env.NODE_ENV !== 'production',
  apiUrl: process.env.NEXT_PUBLIC_API_URL, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, framedBySelf: true });

const config: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  transpilePackages: ['@resuto/ui', '@resuto/contracts'],
  experimental: {
    // A server component that imports one component from the @resuto/ui barrel (the root not-found's Wordmark, the
    // area skeletons of every staff loading.tsx) otherwise makes every 'use client' module the barrel re-exports a
    // client entry of that segment: ~100 kB raw of charts, tables and sheets on every page (21-PERF).
    optimizePackageImports: ['@resuto/ui'],
  },
  outputFileTracingRoot: repoRoot,
  // The contracts package ships CommonJS for Node consumers (API, worker, MCP).
  // The web app compiles its TypeScript source instead, so dev-mode React Refresh
  // works and pages never depend on a stale dist/ build. lib/contracts-entry.ts switches zod's JIT off before
  // re-exporting that source (no CSP 'eval' probe on documents; REM-W08). '@resuto/contracts/lite' is the zod-free
  // subset (packages/contracts/src/lite.ts) that guest and public pages import helpers from.
  webpack(config) {
    config.resolve.alias = { ...config.resolve.alias, '@resuto/contracts$': path.join(repoRoot, 'apps/web/lib/contracts-entry.ts'),
      '@resuto/contracts/lite$': path.join(repoRoot, 'packages/contracts/src/lite.ts') };
    return config;
  },
  // 21-INSIGHTS: routes that merged into the Insights area (the old Analytics tabs, the intelligence customers screen);
  // 22-TYPE: /studio opens the website studio (lib/nav-redirects.ts).
  async redirects() {
    return [...insightsRedirects(), ...navRedirects()];
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
    }, {
      // Later rules override earlier ones for the same header: the canvas may be framed by this site (and nothing else).
      source: '/studio-canvas',
      headers: [
        { key: 'Content-Security-Policy', value: canvasCsp },
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      ],
    }, {
      // Fonts are fetched in CORS mode; the canvas document has an opaque origin (sandboxed frame), so the public,
      // immutable font files allow any origin to read them (they are the same files every page links).
      source: '/fonts/:file*',
      headers: [{ key: 'Access-Control-Allow-Origin', value: '*' }],
    }];
  },
};
export default config;
