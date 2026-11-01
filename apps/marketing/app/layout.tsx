import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { LocaleProvider } from '@/lib/i18n/client';
import '../../web/app/globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://resuto.app'),
  title: { default: 'Resuto — Restaurant operating system', template: '%s · Resuto' },
  description: 'Resuto connects reservations, QR ordering, kitchen operations, payments and restaurant management in Arabic and English.',
  alternates: { canonical: '/' },
  icons: { icon: '/brand/resuto-icon.png' },
  openGraph: { type: 'website', siteName: 'Resuto', url: '/', images: [{ url: '/brand/og-resuto.png', width: 1200, height: 630, alt: 'Resuto' }] },
  twitter: { card: 'summary_large_image', images: ['/brand/og-resuto.png'] },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#173f36' };

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="en" dir="ltr"><body><LocaleProvider>{children}</LocaleProvider></body></html>;
}
