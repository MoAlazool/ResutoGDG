import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PublicMenu } from '@resuto/contracts';
import { langAlternates } from '@/components/landing/legacy-routes';
import { menuBudget, plausible, requestStartedAt, serverRead, within } from '@/components/guest/server';
import { getLocale } from '@/lib/i18n/server';
import { APP_ORIGIN, canonicalUrl, loadSite } from '../../r/[slug]/_components/load-site';
import { pickName } from '../../r/[slug]/_components/site-utils';
import { jsonLdScript, menuPageJsonLd } from '../../r/[slug]/_components/structured-data';
import { MenuOnlyExperience } from './MenuOnlyExperience';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ branch?: string }> };

const SLUG = /^[a-z0-9-]{1,60}$/;
const BRANCH = /^[a-z0-9-]{1,40}$/;

/** The public menu, shared by every guest (cached 30 s, dropped with the menu tag when the restaurant changes it). */
const readMenu = (slug: string, branch?: string) =>
  serverRead<PublicMenu>(`/public/menu/${encodeURIComponent(slug)}${branch ? `?branch=${branch}` : ''}`, { revalidate: 30, tags: [`menu:${slug}`] });

/**
 * The restaurant's published website, when it has one (the menu page shares its canonical host and identity). Cached
 * like the menu (30 s, shared); a slow read is not waited for beyond `ms` (the page then omits what depends on it).
 */
async function readSite(slug: string, ms = 300) {
  const read = await within(loadSite(slug).then((data) => ({ status: 'ok' as const, data }), () => ({ status: 'unavailable' as const })), ms);
  return read.status === 'ok' ? read.data : null;
}
/** The menu page's own address: on the restaurant's custom domain when it has one, else on the app host. */
const menuUrlOf = (slug: string, host: string | null | undefined) => (host ? `https://${host}/m/${slug}` : `${APP_ORIGIN}/m/${slug}`);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!SLUG.test(slug)) return { title: 'Menu', robots: { index: false } };
  const [menu, site, locale] = await Promise.all([readMenu(slug), readSite(slug), getLocale()]);
  if (menu.status !== 'ok') return { title: 'Menu' };
  // 22-STUDIO SEO: a canonical address, hreflang alternates and a factual description of what the page lists.
  const name = pickName(locale, menu.data.org.name, menu.data.org.nameAr);
  const dishes = menu.data.categories.reduce((n, c) => n + c.products.length, 0);
  const title = locale === 'ar' ? `قائمة ${name}` : `${name} menu`;
  const description = locale === 'ar' ? `قائمة ${name}: ${dishes} طبقًا بالأسعار والصور، بالعربية والإنجليزية.`
    : `${name}'s menu: ${dishes} dishes with prices and photos, in English and Arabic.`;
  const url = menuUrlOf(slug, site?.canonicalHost);
  return {
    title: { absolute: title }, description,
    alternates: { canonical: url, languages: langAlternates(url) },
    openGraph: { type: 'website', title, description, url, siteName: name, locale: locale === 'ar' ? 'ar_EG' : 'en_US' },
    twitter: { card: 'summary', title, description },
  };
}

/**
 * The view-only digital menu (21-ONB, plan §6.2): what the menu QR opens. Categories, dishes, prices, photos and
 * availability, with no cart, no ordering and no table session; the ordering QRs stay /t/<token> and /v/<token>.
 *
 * Rendered with the menu in the HTML like the other guest pages (PCL-08, PERF-01): a read still running after the
 * guest menu budget renders the skeleton and loads in the browser. An unknown restaurant is a 404; an unknown branch
 * code (a printed QR for a branch that was closed) falls back to the restaurant's first branch.
 */
export default async function MenuOnlyPage({ params, searchParams }: Props) {
  const started = requestStartedAt();
  const { slug } = await params;
  const { branch } = await searchParams;
  if (!plausible(slug) || !SLUG.test(slug)) notFound();
  let code = typeof branch === 'string' && BRANCH.test(branch) ? branch : undefined;
  let menu = await within(readMenu(slug, code), menuBudget(started));
  if (menu.status === 'missing' && code) {
    code = undefined;
    menu = await within(readMenu(slug), menuBudget(started));
  }
  if (menu.status === 'missing') notFound();
  // schema.org Menu (and the Restaurant it belongs to, under the website's @ids) from the menu in this HTML (22-STUDIO).
  const [published, locale] = menu.status === 'ok' ? await Promise.all([readSite(slug), getLocale()]) : [null, 'en' as const];
  const ld = menu.status === 'ok'
    ? menuPageJsonLd(menu.data, published, published ? canonicalUrl(published) : null, menuUrlOf(slug, published?.canonicalHost), locale) : [];
  return (
    <>
      {ld.map((d, i) => <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(d) }} />)}
      <MenuOnlyExperience slug={slug} branchCode={code} initialMenu={menu.status === 'ok' ? menu.data : null} />
    </>
  );
}
