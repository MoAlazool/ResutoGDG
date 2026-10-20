import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { preload } from 'react-dom';
import { plausible, serverRead } from '@/components/guest/server';
import { WebOrderExperience, type WebMenu } from '../WebOrderExperience';

export const metadata: Metadata = { title: 'Order online' };

/**
 * Website ordering (pickup / delivery). The menu is read while the HTML is rendered (cached 30 s per branch), so the
 * first paint is the real menu (PCL-08); an unknown restaurant is a 404 (CR-03).
 */
export default async function OrderPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ branch?: string }> }) {
  const { slug } = await params;
  const { branch } = await searchParams;
  if (!plausible(slug)) notFound();
  const code = typeof branch === 'string' && /^[a-z0-9-]{1,40}$/.test(branch) ? branch : undefined;
  const menu = await serverRead<WebMenu>(`/public/order/${encodeURIComponent(slug)}${code ? `?branch=${code}` : ''}`, { revalidate: 30, tags: [`menu:${slug}`] });
  if (menu.status === 'missing') notFound();
  // The restaurant's own cover, when it has one (never a stock or another restaurant's photo).
  if (menu.status === 'ok' && menu.data.cover) preload(menu.data.cover, { as: 'image', fetchPriority: 'high' });
  return <WebOrderExperience slug={slug} branchCode={code} initialMenu={menu.status === 'ok' ? menu.data : null} />;
}
