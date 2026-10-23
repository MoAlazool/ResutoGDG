import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import type { PublicCounterView } from '@resuto/contracts';
import { plausible, serverRead } from '@/components/guest/server';

/**
 * Counter (venue QR) page, FT-07. An unknown code is a real 404 with the branded not-found page; the check runs here,
 * outside the loading boundary, and the page's identical lookup is served from the same request cache. When the
 * lookup fails for another reason (rate limited, API down) the page still renders and scans in from the browser.
 */
export default async function CounterLayout({ children, params }: { children: ReactNode; params: Promise<{ qr: string }> }) {
  const { qr } = await params;
  if (!plausible(qr) || !/^[A-Za-z0-9_-]{16,128}$/.test(qr)) notFound();
  const venue = await serverRead<PublicCounterView>(`/public/venue/${encodeURIComponent(qr)}/counter`, { revalidate: 15, tags: [`venue:${qr}`] });
  if (venue.status === 'missing') notFound();
  return children;
}
