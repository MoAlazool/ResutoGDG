import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { LocaleProvider } from '@/lib/i18n/client';
import { getLocale } from '@/lib/i18n/server';
import { SessionProvider } from '@/lib/session';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Resuto — Restaurant operating system', template: '%s · Resuto' },
  description: 'Resuto: the AI-native restaurant operating system for Egypt and Saudi Arabia. QR ordering, reservations, kitchen, payments, WhatsApp ordering, delivery, marketing and finance in one platform.',
  icons: { icon: '/brand/resuto-icon.png' },
  openGraph: { images: ['/brand/og-resuto.png'] },
};

export const viewport: Viewport = { themeColor: '#173f36', width: 'device-width', initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <body>
        <LocaleProvider locale={locale}>
          <SessionProvider>{children}</SessionProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
