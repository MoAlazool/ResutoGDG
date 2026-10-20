import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { paymentLinkExists } from '@/lib/guest-exists';

/** Unknown payment link → HTTP 404 with the branded not-found page (expired links still open and say so). */
export default async function PayTokenLayout({ children, params }: { children: ReactNode; params: Promise<{ token: string }> }) {
  const { token } = await params;
  if ((await paymentLinkExists(token)) === 'missing') notFound();
  return children;
}
