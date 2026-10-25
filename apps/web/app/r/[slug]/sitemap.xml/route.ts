import { canonicalUrl, loadSite } from '../_components/load-site';
import { acceptsOrders, acceptsReservations } from '../_components/site-utils';

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const withLang = (url: string, lang: 'en' | 'ar') => `${url}${url.includes('?') ? '&' : '?'}lang=${lang}`;

/**
 * A restaurant website's own sitemap (21-STUDIO SEO): the site, its menu, booking and storefront pages, each with its
 * English and Arabic alternates (hreflang en, ar, x-default) — the same alternates the pages declare. Only published
 * sites have one. Submit it in Search Console as /r/<slug>/sitemap.xml.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const site = await loadSite(slug).catch(() => null);
  if (!site) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  const home = canonicalUrl(site);
  const base = site.canonicalHost ? `https://${site.canonicalHost}` : home.replace(/\/r\/[^/]+$/, '');
  const pages = [
    home,
    ...(acceptsOrders(site) ? [`${base}${site.canonicalHost ? '/order' : site.links.order}`] : []),
    ...(acceptsReservations(site) ? [`${base}${site.canonicalHost ? '/reserve' : site.links.reserve}`] : []),
    ...(site.storefronts ?? []).map((sf) => `${base}${site.canonicalHost ? sf.path.replace(/^\/r\/[^/]+/, '') : sf.path}`),
  ];
  const lastmod = site.publishedAt ? `<lastmod>${xml(site.publishedAt)}</lastmod>` : '';
  const body = pages.map((u) => `<url><loc>${xml(u)}</loc>${lastmod}`
    + `<xhtml:link rel="alternate" hreflang="en" href="${xml(withLang(u, 'en'))}"/>`
    + `<xhtml:link rel="alternate" hreflang="ar" href="${xml(withLang(u, 'ar'))}"/>`
    + `<xhtml:link rel="alternate" hreflang="x-default" href="${xml(u)}"/></url>`).join('');
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${body}</urlset>`, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}
