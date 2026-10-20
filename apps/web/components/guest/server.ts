// Server-side reads for the guest pages (PCL-08): the restaurant, table and menu are fetched while the HTML is
// rendered, so the first paint is the real menu instead of a skeleton waiting for client JavaScript. Only an explicit
// 404 means "missing" (→ notFound()); any other failure returns null and the page falls back to loading in the browser.
// Server components only (it reads API_INTERNAL_URL).

const SERVER_API_URL = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');

/** Values that cannot be a slug or token (too long, path or control characters). */
export const plausible = (v: string) => v.length > 0 && v.length <= 256 && !/[\s/\\?#%]/.test(v);

export type ServerRead<T> = { status: 'ok'; data: T } | { status: 'missing' } | { status: 'unavailable' };

export async function serverRead<T>(path: string, init: { revalidate?: number; tags?: string[] } = {}, timeoutMs = 3500): Promise<ServerRead<T>> {
  try {
    const res = await fetch(`${SERVER_API_URL}/v1${path}`, {
      headers: { Accept: 'application/json' },
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
