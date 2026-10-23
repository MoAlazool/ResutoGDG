import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { requestStartedAt } from '@/components/guest/server';
import { restaurantExists } from '@/lib/guest-exists';

/** Unknown restaurant → HTTP 404 with the branded not-found page (CR-03). */
export default async function OrderSlugLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  requestStartedAt();   // the guest menu budget counts from here (components/guest/server.ts)
  const { slug } = await params;
  if ((await restaurantExists(slug)) === 'missing') notFound();
  return children;
}
