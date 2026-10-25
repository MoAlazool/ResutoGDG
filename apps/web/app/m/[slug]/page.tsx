import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PublicMenu } from '@resuto/contracts';
import { menuBudget, plausible, requestStartedAt, serverRead, within } from '@/components/guest/server';
import { MenuOnlyExperience } from './MenuOnlyExperience';

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<{ branch?: string }> };

const SLUG = /^[a-z0-9-]{1,60}$/;
const BRANCH = /^[a-z0-9-]{1,40}$/;

/** The public menu, shared by every guest (cached 30 s, dropped with the menu tag when the restaurant changes it). */
const readMenu = (slug: string, branch?: string) =>
  serverRead<PublicMenu>(`/public/menu/${encodeURIComponent(slug)}${branch ? `?branch=${branch}` : ''}`, { revalidate: 30, tags: [`menu:${slug}`] });

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  if (!SLUG.test(slug)) return { title: 'Menu', robots: { index: false } };
  const menu = await readMenu(slug);
  if (menu.status !== 'ok') return { title: 'Menu' };
  return { title: menu.data.org.name };
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
  return <MenuOnlyExperience slug={slug} branchCode={code} initialMenu={menu.status === 'ok' ? menu.data : null} />;
}
