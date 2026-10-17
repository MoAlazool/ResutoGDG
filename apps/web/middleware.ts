import { NextResponse, type NextRequest } from 'next/server';

/**
 * Custom-domain routing for restaurant websites. Requests whose Host is not one
 * of the app hosts (APP_HOSTS, default localhost) are resolved through the
 * public by-host endpoint and rewritten to that tenant's /r/<slug> site.
 * Resolution is cached in memory per instance (60 s hits, 30 s misses).
 */
const API = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
const APP_HOSTS = new Set((process.env.APP_HOSTS ?? 'localhost,127.0.0.1').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean));
const HIT_TTL = 60_000;
const MISS_TTL = 30_000;
const cache = new Map<string, { slug: string | null; at: number }>();
/** Guest routes already qualified by slug/token work on every host unchanged. */
const PASS_THROUGH = /^\/(reserve|order|t|pay|s|o|l)\/[^/]+/;

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

export async function middleware(req: NextRequest) {
  const host = (req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '').split(',')[0]!.trim().toLowerCase().replace(/:\d+$/, '');
  if (!host || APP_HOSTS.has(host)) return NextResponse.next();
  const { pathname } = req.nextUrl;
  if (PASS_THROUGH.test(pathname)) return NextResponse.next();

  const slug = await resolveHost(host);
  const url = req.nextUrl.clone();
  if (!slug) {
    url.pathname = '/r/_unknown-host';
    return NextResponse.rewrite(url, { status: 404 });
  }
  const headers = new Headers(req.headers);
  headers.set('x-resuto-site-host', host);
  if (pathname === '/' || pathname === '') url.pathname = `/r/${slug}`;
  else if (pathname === '/reserve' || pathname === '/order') url.pathname = `${pathname}/${slug}`;
  else url.pathname = `/r/${slug}${pathname}`;
  return NextResponse.rewrite(url, { request: { headers } });
}

export const config = {
  // Skip Next internals and static files (anything with an extension).
  matcher: ['/((?!_next/|api/|.*\\.[a-zA-Z0-9]+$).*)'],
};
