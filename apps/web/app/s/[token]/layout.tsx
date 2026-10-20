import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { shareLinkExists } from '@/lib/guest-exists';

/** Unknown split-bill link → HTTP 404 with the branded not-found page (CR-03). */
export default async function ShareTokenLayout({ children, params }: { children: ReactNode; params: Promise<{ token: string }> }) {
  const { token } = await params;
  if ((await shareLinkExists(token)) === 'missing') notFound();
  return children;
}
