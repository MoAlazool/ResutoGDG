import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { preload } from 'react-dom';
import { metadataBase } from '@/lib/app-origin';
import { FONT_PRELOAD, PRIMARY_FONT } from '@/lib/fonts';
import { LocaleProvider } from '@/lib/i18n/client';
import { messagesFor } from '@/lib/i18n/messages';
import { getLocale } from '@/lib/i18n/server';
import './globals.css';

export const metadata: Metadata = {
  // Relative Open Graph/Twitter images of every page resolve against the app origin, not http://localhost:3000.
  metadataBase: metadataBase(),
  title: { default: 'Resuto — Restaurant operating system', template: '%s · Resuto' },
  description: 'Resuto: the AI-native restaurant operating system for Egypt and Saudi Arabia. QR ordering, reservations, kitchen, payments, WhatsApp ordering, delivery, marketing and finance in one platform.',
  icons: { icon: '/brand/resuto-icon.png' },
  openGraph: { images: ['/brand/og-resuto.png'] },
};

export const viewport: Viewport = { themeColor: '#173f36', width: 'device-width', initialScale: 1 };

/**
 * Root layout: document language/direction and the base messages (app name, actions, states, errors) for the active
 * locale only. Every route group adds its own scope in its layout: guest pages the guest copy (lib/i18n/scope.tsx
 * ScopeMessages), staff route groups their namespaces and the session (components/shell/StaffProviders). Before
 * 21-PERF this layout shipped the whole guest scope (~55 KB of text) to every document, staff and sign-in pages included.
 * The active locale's primary font is preloaded (one file; lib/fonts.ts).
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  preload(PRIMARY_FONT[locale], FONT_PRELOAD);
  return (
    <html lang={locale} dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <body>
        <LocaleProvider locale={locale} messages={messagesFor(locale, 'base')}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
