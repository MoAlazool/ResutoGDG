import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { preload } from 'react-dom';
import type { PublicCounterView, PublicMenu } from '@resuto/contracts';
import { plausible, serverRead } from '@/components/guest/server';
import { CounterExperience } from './_counter/CounterExperience';

export const metadata: Metadata = { title: 'Menu', robots: { index: false, follow: false } };

/**
 * The counter's venue QR (FT-07; legacy /t/<venueQr> on a counter restaurant). The restaurant and branch come from the
 * read-only venue lookup (no visit is opened here) and the menu from the public menu, both while the HTML renders;
 * scanning in (this guest's own counter visit) happens in the browser.
 */
export default async function CounterPage({ params }: { params: Promise<{ qr: string }> }) {
  const { qr } = await params;
  if (!plausible(qr) || !/^[A-Za-z0-9_-]{16,128}$/.test(qr)) notFound();
  const venue = await serverRead<PublicCounterView>(`/public/venue/${encodeURIComponent(qr)}/counter`, { revalidate: 15, tags: [`venue:${qr}`] });
  if (venue.status === 'missing') notFound();
  const v = venue.status === 'ok' ? venue.data : null;
  const menu = v ? await serverRead<PublicMenu>(`/public/menu/${encodeURIComponent(v.org.slug)}?branch=${encodeURIComponent(v.branch.code)}`,
    { revalidate: 30, tags: [`menu:${v.org.slug}`] }) : null;
  if (v?.cover) preload(v.cover, { as: 'image', fetchPriority: 'high' });
  return <CounterExperience code={qr} venue={v} initialMenu={menu?.status === 'ok' ? menu.data : null} />;
}
