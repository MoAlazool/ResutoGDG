// Server-side existence checks for guest links, so an unknown restaurant or token answers HTTP 404 with the branded
// not-found page instead of a 200 page that shows a booking form or checkout for nothing (CR-03). Used by the guest
// route layouts; the pages themselves still load their data in the browser.
//
// Only an explicit 404 from the API counts as "missing". Any other failure (API down, rate limit, timeout) renders
// the page normally so it can show its own retryable error; a guest is never turned away because of an outage.

const SERVER_API_URL = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** Values that cannot be a slug or token (too long, path or control characters) are missing without asking the API. */
const plausible = (v: string) => v.length > 0 && v.length <= 256 && !/[\s/\\?#%]/.test(v);

export type Existence = 'exists' | 'missing' | 'unknown';

async function probe(path: string, init: RequestInit & { next?: { revalidate?: number } }, timeoutMs = 2500): Promise<Existence> {
  try {
    const res = await fetch(`${SERVER_API_URL}/v1${path}`, { ...init, headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 404) return 'missing';
    return res.ok ? 'exists' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A restaurant's public ordering/booking identity (cached 30 s per slug, shared with other guests). */
export function restaurantExists(slug: string): Promise<Existence> {
  if (!plausible(slug)) return Promise.resolve('missing');
  return probe(`/public/menu/${encodeURIComponent(slug)}`, { next: { revalidate: 30 } });
}

/** A hosted payment link (never cached: links expire and are single-purpose). */
export function paymentLinkExists(token: string): Promise<Existence> {
  if (!plausible(token)) return Promise.resolve('missing');
  return probe(`/public/pay/${encodeURIComponent(token)}`, { cache: 'no-store' });
}

/** A split-bill share link (never cached). */
export function shareLinkExists(token: string): Promise<Existence> {
  if (!plausible(token)) return Promise.resolve('missing');
  return probe(`/public/payments/shares/${encodeURIComponent(token)}`, { cache: 'no-store' });
}
