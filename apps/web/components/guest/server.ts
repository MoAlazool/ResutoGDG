// Server-side reads for the guest pages (PCL-08): the restaurant, table and menu are fetched while the HTML is
// rendered, so the first paint is the real menu instead of a skeleton waiting for client JavaScript. Only an explicit
// 404 means "missing" (→ notFound()); any other failure returns null and the page falls back to loading in the browser.
// Server components only (it reads API_INTERNAL_URL, CLIENT_IP_FORWARD_SECRET and WEB_TRUST_PROXY).
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { unstable_cache } from 'next/cache';
import { headers } from 'next/headers';
import { cache } from 'react';

const SERVER_API_URL = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** Values that cannot be a slug or token (too long, path or control characters). */
export const plausible = (v: string) => v.length > 0 && v.length <= 256 && !/[\s/\\?#%]/.test(v);

export type ServerRead<T> = { status: 'ok'; data: T } | { status: 'missing' } | { status: 'unavailable' };

/**
 * Guest address forwarding (REM-A11). These reads are made by this server on a guest's behalf, so without it every
 * guest counted against the web server's single rate-limit bucket at the API. The guest address is sent with an HMAC
 * made with CLIENT_IP_FORWARD_SECRET, which the API verifies (apps/api/src/common/http/client-forwarding.ts) before
 * using it as the client address. Without the secret nothing is sent and nothing changes.
 *
 * Where the address comes from is a deployment fact, so it is configured, never guessed (WEB_TRUST_PROXY):
 * - unset / anything else: nothing is forwarded (a guest reaching `next start` directly could otherwise choose any
 *   address and get a fresh rate-limit bucket on every request);
 * - "x-real-ip": the edge in front of this server sets X-Real-IP to the connecting address, overwriting what the
 *   client sent (Vercel does; nginx with `proxy_set_header X-Real-IP $remote_addr`);
 * - a hop count N (1-9): N proxies in front of this server each append to X-Forwarded-For, so the client is the Nth
 *   entry from the right (entries further left are whatever the client sent).
 */
const FORWARD_WINDOW_SECONDS = 600;

export function forwardHeaders(ip: string | null | undefined, secret: string | undefined, now = Date.now()): Record<string, string> {
  if (!secret || !ip || ip.length > 45 || !isIP(ip)) return {};
  const w = Math.floor(now / 1000 / FORWARD_WINDOW_SECONDS);
  const sig = createHmac('sha256', secret).update(`resuto-client-ip:v1:${w}:${ip}`).digest('hex');
  return { 'X-Resuto-Client-IP': ip, 'X-Resuto-Forward-Sig': `w=${w},v1=${sig}` };
}

/** The guest's address as the trusted edge reported it (WEB_TRUST_PROXY), or null when not trusted or absent. */
export function clientAddress(h: { get(name: string): string | null }, trust: string | undefined): string | null {
  const mode = trust?.trim().toLowerCase();
  if (mode === 'x-real-ip') return h.get('x-real-ip')?.trim() || null;
  if (mode && /^[1-9]$/.test(mode)) {
    const hops = (h.get('x-forwarded-for') ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    return hops.length >= Number(mode) ? hops[hops.length - Number(mode)]! : null;
  }
  return null;
}

async function forwarded(): Promise<Record<string, string>> {
  const secret = process.env.CLIENT_IP_FORWARD_SECRET;
  if (!secret || !process.env.WEB_TRUST_PROXY) return {};
  try {
    return forwardHeaders(clientAddress(await headers(), process.env.WEB_TRUST_PROXY), secret);
  } catch {
    return {};   // not inside a request (static generation): nothing to forward
  }
}

async function read<T>(url: string, forward: Record<string, string>, timeoutMs: number): Promise<ServerRead<T>> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', ...forward },
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'unavailable' };
    return { status: 'ok', data: (await res.json()) as T };
  } catch {
    return { status: 'unavailable' };
  }
}

/** Thrown inside the shared cache so a 404 or a failure is never stored (only successful reads are, as before). */
class NotCached extends Error {
  constructor(readonly outcome: 'missing' | 'unavailable') { super(outcome); }
}

/**
 * A read for a guest page. Without `revalidate` it is made for this guest only (no-store) and carries the guest's
 * forwarded address. With `revalidate`, the result is shared by every guest: it is cached by path and tags only
 * (unstable_cache), never by request headers. Next's fetch data cache would put the forwarded headers into its key,
 * making the menu, floor, venue and table reads one cache entry per guest address and window (review of REM-A11).
 * On a miss the API call still carries the address of the guest whose visit caused it, so misses (for example a
 * scan of unknown table codes, whose 404s are not cached) count against that guest, not against everyone.
 */
export function serverRead<T>(path: string, init: { revalidate?: number; tags?: string[] } = {}, timeoutMs = 3500): Promise<ServerRead<T>> {
  return readOnce(path, init.revalidate ?? null, (init.tags ?? []).join('\n'), timeoutMs) as Promise<ServerRead<T>>;
}

/**
 * How long a guest page's HTML may wait for its menu (PERF-01). The menu is rendered in the page itself, not behind a
 * streamed loading boundary: content revealed after a fallback waits for React's batched reveal timer, which a repeat
 * visit's cached JavaScript delays until hydration has finished. A warm read (the usual case: shared, cached 30 s and
 * refreshed in the background) takes milliseconds. A cold read that is still running after this budget is not waited
 * for: the page renders with its branded menu skeleton and loads the menu in the browser, while the server read
 * carries on and fills the shared cache for the next guest.
 */
export const GUEST_MENU_BUDGET_MS = 1200;

/**
 * The budget counts from the start of the request, not from the menu read (PERF-01 review): the route layouts first
 * await the restaurant / table read, and on a cold server cache that time used to come on top of the 1.2 s, holding
 * the first byte for up to read + 1.2 s. The layout and the page both call requestStartedAt() first thing; React's
 * request memoisation keeps the earliest. The menu read always gets at least GUEST_MENU_MIN_MS, which a warm (cached)
 * read answers well within.
 */
export const requestStartedAt = cache((): number => Date.now());
export const GUEST_MENU_MIN_MS = 150;
export function menuBudget(startedAt: number, now = Date.now()): number {
  return Math.max(GUEST_MENU_MIN_MS, GUEST_MENU_BUDGET_MS - Math.max(0, now - startedAt));
}

/** `read`, or `{ status: 'late' }` once `ms` has passed (the read itself is not cancelled). */
export function within<T>(read: Promise<ServerRead<T>>, ms: number): Promise<ServerRead<T> | { status: 'late' }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<{ status: 'late' }>((resolve) => { timer = setTimeout(() => resolve({ status: 'late' }), ms); });
  return Promise.race([read, late]).finally(() => clearTimeout(timer));
}

// One read per render for the same arguments (a layout and its page both ask for the table): React's request
// memoisation, which Next applied to the plain fetch before, keyed here on primitives so it actually matches.
const readOnce = cache(async (path: string, revalidate: number | null, tagList: string, timeoutMs: number): Promise<ServerRead<unknown>> => {
  const forward = await forwarded();
  if (revalidate === null) return read(`${SERVER_API_URL}/v1${path}`, forward, timeoutMs);
  const shared = unstable_cache(async (p: string): Promise<unknown> => {
    const r = await read(`${SERVER_API_URL}/v1${p}`, forward, timeoutMs);
    if (r.status !== 'ok') throw new NotCached(r.status);
    return r.data;
  }, ['guest-server-read'], { revalidate, tags: tagList ? tagList.split('\n') : undefined });
  try {
    return { status: 'ok', data: await shared(path) };
  } catch (e) {
    return { status: e instanceof NotCached ? e.outcome : 'unavailable' };
  }
});
