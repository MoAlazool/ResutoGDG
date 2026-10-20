import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { PublicMenu } from '@resuto/contracts';
import { plausible, serverRead } from '@/components/guest/server';
import { TrackClient } from './TrackClient';

export const metadata: Metadata = { title: 'Your order', robots: { index: false, follow: false } };

/**
 * Public order tracking by its unguessable reference, in the consumer shell (legacy statusPage()). An unknown reference
 * is a real 404 (CR-03); the order itself is read (and then polled) in the browser, never cached on the server.
 */
export default async function TrackPage({ params }: { params: Promise<{ slug: string; ref: string }> }) {
  const { slug, ref } = await params;
  if (!plausible(ref) || !/^[0-9a-f]{12,64}$/.test(ref)) notFound();
  const [menu, order] = await Promise.all([
    serverRead<PublicMenu>(`/public/menu/${encodeURIComponent(slug)}`, { revalidate: 30, tags: [`menu:${slug}`] }),
    serverRead<unknown>(`/public/order/${encodeURIComponent(slug)}/orders/${encodeURIComponent(ref)}`),
  ]);
  if (order.status === 'missing') notFound();
  return <TrackClient slug={slug} orderRef={ref} org={menu.status === 'ok' ? menu.data.org : null} />;
}
