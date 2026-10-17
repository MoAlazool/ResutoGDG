import { cache } from 'react';
import type { PublicSite } from '@resuto/contracts';

/** Server-side API base (an internal URL may be set for server-to-server calls). */
export const SERVER_API_URL = (process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000').replace(/\/$/, '');
export const APP_ORIGIN = (process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
const SLUG = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;

/** Published site for a slug; null when unknown/unpublished. Cached per request, revalidated every 30 s. */
export const loadSite = cache(async (slug: string): Promise<PublicSite | null> => {
  if (!SLUG.test(slug)) return null;
  const res = await fetch(`${SERVER_API_URL}/v1/public/sites/${encodeURIComponent(slug)}`, { next: { revalidate: 30, tags: [`site:${slug}`] } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Website service returned ${res.status}`);
  return (await res.json()) as PublicSite;
});

export const canonicalUrl = (site: PublicSite) => (site.canonicalHost ? `https://${site.canonicalHost}/` : `${APP_ORIGIN}/r/${site.slug}`);
