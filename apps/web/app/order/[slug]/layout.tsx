import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { restaurantExists } from '@/lib/guest-exists';

/** Unknown restaurant → HTTP 404 with the branded not-found page (CR-03). */
export default async function OrderSlugLayout({ children, params }: { children: ReactNode; params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if ((await restaurantExists(slug)) === 'missing') notFound();
  return children;
}
