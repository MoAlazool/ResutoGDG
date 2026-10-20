import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { shareLinkExists } from '@/lib/guest-exists';
import { getT } from '@/lib/i18n/server';

/**
 * Its own tab title ("Your share · Resuto") instead of the platform default (VP-17). A share link is the payer's
 * credential, so the page is never indexed and the full URL is never sent as a referrer.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t('pay.share.title'), robots: { index: false, follow: false }, referrer: 'no-referrer' };
}

/** Unknown split-bill link → HTTP 404 with the branded not-found page (CR-03). */
export default async function ShareTokenLayout({ children, params }: { children: ReactNode; params: Promise<{ token: string }> }) {
  const { token } = await params;
  if ((await shareLinkExists(token)) === 'missing') notFound();
  return children;
}
