'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Wordmark } from '@resuto/ui';
import { LanguageToggle, useT } from '@/lib/i18n/client';

/** The legacy split sign-in layout (brand panel + form column) shared by the CR-05 account pages. */
export function AuthPanel({ eyebrow, title, body, children }: { eyebrow: string; title: string; body?: ReactNode; children: ReactNode }) {
  const { t } = useT();
  return (
    <div className="login">
      <section className="login-brand" aria-label={t('auth.brand.foot')}>
        <Link href="/" className="ws-brand" aria-label={t('app.name')}><Wordmark tone="light" label={t('app.name')} /></Link>
        <div>
          <div className="eyebrow">{t('auth.brand.eyebrow')}</div>
          <h1>{t('auth.brand.line1')}<br />{t('auth.brand.line2')}<br />{t('auth.brand.line3')}</h1>
          <p>{t('auth.brand.body')}</p>
        </div>
        <small>{t('auth.brand.foot')}</small>
      </section>
      <main className="login-main">
        <div className="login-form">
          <div className="eyebrow">{eyebrow}</div>
          <h1>{title}</h1>
          {body && <p>{body}</p>}
          {children}
        </div>
      </main>
      <LanguageToggle className="ws-lang" label={t('lang.short')} />
    </div>
  );
}

/** Length range for a new password (AUTH-01: lib/auth/password-policy.ts is the single source). */
export { MAX_PASSWORD, MIN_PASSWORD } from '@/lib/auth/password-policy';
