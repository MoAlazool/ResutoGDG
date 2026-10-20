import { NextResponse, type NextRequest } from 'next/server';
import { buildCsp, newNonce } from './lib/csp';

/**
 * Sets the per-request Content-Security-Policy nonce on every page (lib/csp.ts), and does custom-domain routing
 * for restaurant websites. Requests whose Host is not one
 * of the app hosts (APP_HOSTS, default localhost) are resolved through the
 * public by-host endpoint and rewritten to that tenant's /r/<slug> site.
 * Resolution is cached in memory per instance (60 s hits, 30 s misses).
 */
const API = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const APP_HOSTS = new Set((process.env.APP_HOSTS ?? 'localhost,127.0.0.1').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
/** Entries starting with "." match every subdomain (e.g. ".vercel.app" for preview deployment URLs). */
const APP_HOST_SUFFIXES = [...APP_HOSTS].filter((h) => h.startsWith('.'));
const isAppHost = (host: string) => APP_HOSTS.has(host) || APP_HOST_SUFFIXES.some((s) => host.endsWith(s));
const HIT_TTL = 60_000;
const MISS_TTL = 30_000;
const cache = new Map<string, { slug: string | null; at: number }>();
/** Guest routes already qualified by slug/token work on every host unchanged. */
const PASS_THROUGH = /^\/(reserve|order|t|pay|s|o|l)\/[^/]+/;
/** Restaurant website, web ordering and booking pages: the only places the Meta Pixel can run. */
const GUEST_SITE = /^\/(r|order|reserve)\/[^/]+/;

async function resolveHost(host: string): Promise<string | null> {
  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < (hit.slug ? HIT_TTL : MISS_TTL)) return hit.slug;
  let slug: string | null = null;
  try {
    const res = await fetch(`${API}/v1/public/sites/by-host/${encodeURIComponent(host)}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(5000) });
    if (res.ok) slug = ((await res.json()) as { slug?: string }).slug ?? null;
    else if (res.status !== 404) return hit?.slug ?? null; // service trouble: keep the last answer, do not cache
  } catch {
    return hit?.slug ?? null;
  }
  if (cache.size > 5000) cache.clear();
  cache.set(host, { slug, at: Date.now() });
  return slug;
}

const CSP_DEV = process.env.NODE_ENV !== 'production';

export async function middleware(req: NextRequest) {
  // Per-request script nonce (audit PS-17, lib/csp.ts): Next.js reads it from the request's CSP header and adds it
  // to its own scripts; the browser gets the same policy on the response. Every return below goes through secure().
  const nonce = newNonce();
  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').split(',')[0]!.trim().toLowerCase().replace(/:\d+$/, '');
  // Restaurant website pages (and custom domains) may run the consented Meta Pixel (INT-20); staff pages never.
  const metaPixel = GUEST_SITE.test(req.nextUrl.pathname) || (!!host && !isAppHost(host) && !/^\/(pay|s|t|o)\//.test(req.nextUrl.pathname));
  const csp = buildCsp({ nonce, dev: CSP_DEV, apiUrl: process.env.NEXT_PUBLIC_API_URL, supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL, metaPixel });
  const headers = new Headers(req.headers);
  headers.set('content-security-policy', csp);
  const secure = (res: NextResponse) => { res.headers.set('Content-Security-Policy', csp); return res; };

  if (!host || isAppHost(host)) return secure(NextResponse.next({ request: { headers } }));
  const { pathname } = req.nextUrl;
  if (PASS_THROUGH.test(pathname)) return secure(NextResponse.next({ request: { headers } }));

  const slug = await resolveHost(host);
  const url = req.nextUrl.clone();
  if (!slug) {
    url.pathname = '/r/_unknown-host';
    return secure(NextResponse.rewrite(url, { status: 404, request: { headers } }));
  }
  headers.set('x-resuto-site-host', host);
  if (pathname === '/' || pathname === '') url.pathname = `/r/${slug}`;
  else if (pathname === '/reserve' || pathname === '/order') url.pathname = `${pathname}/${slug}`;
  else url.pathname = `/r/${slug}${pathname}`;
  return secure(NextResponse.rewrite(url, { request: { headers } }));
}

export const config = {
  // Skip Next internals and static files (anything with an extension).
  matcher: ['/((?!_next/|api/|.*\\.[a-zA-Z0-9]+$).*)'],
};
