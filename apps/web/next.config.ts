import type { NextConfig } from 'next';
import path from 'node:path';

const repoRoot = new URL('../..', import.meta.url).pathname;

const originOf = (url: string | undefined) => {
  try { return url ? new URL(url).origin : null; } catch { return null; }
};

/**
 * Content-Security-Policy for every page (audit PS-17). The session token lives in localStorage, so the policy limits
 * where a script could send it and who may frame the app: connections only to this site, the API and Supabase Auth;
 * no plugins, no <base> hijack, forms post only here, no framing (also covers the hosted pay page).
 * Next.js's App Router streams inline bootstrap scripts and this config cannot mint per-request nonces (no
 * middleware CSP), so script-src keeps 'unsafe-inline'; development adds 'unsafe-eval' and websockets for HMR.
 * Product images may come from any HTTPS host (menu imports, tenant URLs), so img-src allows https:.
 */
function contentSecurityPolicy(): string {
  const dev = process.env.NODE_ENV !== 'production';
  const api = originOf(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000');
  const supabase = originOf(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const supabaseWs = supabase ? supabase.replace(/^http/, 'ws') : null;
  const secure = !!api?.startsWith('https:');
  const list = (...xs: Array<string | null | false>) => xs.filter(Boolean).join(' ');
  return [
    "default-src 'self'",
    list("script-src 'self' 'unsafe-inline'", dev && "'unsafe-eval'"),
    "style-src 'self' 'unsafe-inline'",
    list("img-src 'self' data: blob: https:", api),
    "font-src 'self' data:",
    list("connect-src 'self'", api, supabase, supabaseWs, dev && 'ws: wss:'),
    list("media-src 'self' blob: https:", api),
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    secure && 'upgrade-insecure-requests',
  ].filter(Boolean).join('; ');
}

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
        { key: 'Content-Security-Policy', value: contentSecurityPolicy() },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
      ],
    }];
  },
};
export default config;
