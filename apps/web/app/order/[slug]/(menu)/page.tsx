import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { preload } from 'react-dom';
import { menuBudget, plausible, requestStartedAt, serverRead, within } from '@/components/guest/server';
import { WebOrderExperience, type WebMenu } from '../WebOrderExperience';

export const metadata: Metadata = { title: 'Order online' };

/**
 * Website ordering (pickup / delivery). The menu is read while the HTML is rendered (cached 30 s per branch), so the
 * first paint is the real menu (PCL-08); an unknown restaurant is a 404 (CR-03, decided by the layout).
 *
 * There is deliberately no loading.tsx on this route (PERF-01): a loading boundary streams the page behind a fallback,
 * and React reveals streamed content with a batched timer that a repeat visit's cached JavaScript delays until
 * hydration has finished (repeat-visit LCP ~1.35 s instead of ~0.3 s on the lab mobile profile). The heading and menu
 * are in the HTML itself; a menu read still running GUEST_MENU_BUDGET_MS after the request started renders the menu skeleton and loads in the
 * browser instead of holding the page (scripts/perf/guest-shell.mjs checks the HTML).
 */
export default async function OrderPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ branch?: string }> }) {
  const started = requestStartedAt();
  const { slug } = await params;
  const { branch } = await searchParams;
  if (!plausible(slug)) notFound();
  const code = typeof branch === 'string' && /^[a-z0-9-]{1,40}$/.test(branch) ? branch : undefined;
  const menu = await within(serverRead<WebMenu>(`/public/order/${encodeURIComponent(slug)}${code ? `?branch=${code}` : ''}`, { revalidate: 30, tags: [`menu:${slug}`] }),
    menuBudget(started));
  if (menu.status === 'missing') notFound();
  // The restaurant's own cover, when it has one (never a stock or another restaurant's photo).
  if (menu.status === 'ok' && menu.data.cover) preload(menu.data.cover, { as: 'image', fetchPriority: 'high' });
  return <WebOrderExperience slug={slug} branchCode={code} initialMenu={menu.status === 'ok' ? menu.data : null} />;
}
