'use client';
import { useEffect, useState } from 'react';
import { ErrorView, documentLang } from '@/components/shell/ErrorView';
import './globals.css';

/**
 * Last-resort boundary when the root layout itself fails (replaces Next's unbranded "Application error"). It renders
 * its own <html>; the language comes from the locale cookie. Chunk load failures reload once (ErrorView).
 */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const [lang, setLang] = useState<'en' | 'ar'>('en');
  useEffect(() => setLang(documentLang()), []);
  return (
    <html lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
      <body>
        <ErrorView error={error} reset={reset} />
      </body>
    </html>
  );
}
