// Server-side reads for the guest pages (PCL-08): the restaurant, table and menu are fetched while the HTML is
// rendered, so the first paint is the real menu instead of a skeleton waiting for client JavaScript. Only an explicit
// 404 means "missing" (→ notFound()); any other failure returns null and the page falls back to loading in the browser.
// Server components only (it reads API_INTERNAL_URL and CLIENT_IP_FORWARD_SECRET).
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';
import { headers } from 'next/headers';

const SERVER_API_URL = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** Values that cannot be a slug or token (too long, path or control characters). */
export const plausible = (v: string) => v.length > 0 && v.length <= 256 && !/[\s/\\?#%]/.test(v);

export type ServerRead<T> = { status: 'ok'; data: T } | { status: 'missing' } | { status: 'unavailable' };

/**
 * Guest address forwarding (REM-A11). These reads are made by this server on a guest's behalf, so without it every
 * guest counted against the web server's single rate-limit bucket at the API. The guest address (x-real-ip, set by
 * the platform's edge, or the first x-forwarded-for entry) is sent with an HMAC made with CLIENT_IP_FORWARD_SECRET,
 * which the API verifies (apps/api/src/common/http/client-forwarding.ts) before using it as the client address.
 * The signature covers a 10-minute window rather than a timestamp, so the headers (part of the fetch cache key) stay
 * stable and cached reads keep working per guest. Without the secret nothing is sent and nothing changes.
 * The incoming x-real-ip / x-forwarded-for must come from a proxy the deployment trusts (Vercel sets them).
 */
const FORWARD_WINDOW_SECONDS = 600;

export function forwardHeaders(ip: string | null | undefined, secret: string | undefined, now = Date.now()): Record<string, string> {
  if (!secret || !ip || ip.length > 45 || !isIP(ip)) return {};
  const w = Math.floor(now / 1000 / FORWARD_WINDOW_SECONDS);
  const sig = createHmac('sha256', secret).update(`resuto-client-ip:v1:${w}:${ip}`).digest('hex');
  return { 'X-Resuto-Client-IP': ip, 'X-Resuto-Forward-Sig': `w=${w},v1=${sig}` };
}

/** The guest's address as the edge reported it, or null outside a request (build time) or when absent. */
export function clientAddress(h: { get(name: string): string | null }): string | null {
  const direct = h.get('x-real-ip')?.trim();
  if (direct) return direct;
  return h.get('x-forwarded-for')?.split(',')[0]?.trim() || null;
}

async function forwarded(): Promise<Record<string, string>> {
  const secret = process.env.CLIENT_IP_FORWARD_SECRET;
  if (!secret) return {};
  try {
    return forwardHeaders(clientAddress(await headers()), secret);
  } catch {
    return {};   // not inside a request (static generation): nothing to forward
  }
}

export async function serverRead<T>(path: string, init: { revalidate?: number; tags?: string[] } = {}, timeoutMs = 3500): Promise<ServerRead<T>> {
  try {
    const res = await fetch(`${SERVER_API_URL}/v1${path}`, {
      headers: { Accept: 'application/json', ...(await forwarded()) },
      signal: AbortSignal.timeout(timeoutMs),
      ...(init.revalidate !== undefined ? { next: { revalidate: init.revalidate, tags: init.tags } } : { cache: 'no-store' as const }),
    });
    if (res.status === 404) return { status: 'missing' };
    if (!res.ok) return { status: 'unavailable' };
    return { status: 'ok', data: (await res.json()) as T };
  } catch {
    return { status: 'unavailable' };
  }
}
