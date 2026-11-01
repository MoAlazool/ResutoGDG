'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';
import { Switcher, Wordmark } from '../../web/components/landing/Chrome';
import './marketing.css';

const nav = [
  ['/pricing/', ['Pricing', 'الأسعار']],
  ['/about/', ['About', 'عن ريسوتو']],
  ['/contact/', ['Contact', 'تواصل معنا']],
] as const;

export function PublicShell({ children }: { children: ReactNode }) {
  const { locale } = useT();
  const ar = locale === 'ar';
  const c = (pair: readonly [string, string]) => pair[ar ? 1 : 0];
  return (
    <div className="mk-shell">
      <header className="mk-nav">
        <Link className="lp-logo" href="/" aria-label="Resuto"><Wordmark rtl={ar} /></Link>
        <nav aria-label={c(['Main navigation', 'التنقل الرئيسي'])}>
          {nav.map(([href, label]) => <Link key={href} href={href}>{c(label)}</Link>)}
        </nav>
        <div className="mk-nav-actions"><Switcher L={{ rtl: ar } as never} /><Link className="lp-btn lp-btn-solid" href="/contact/?subject=request-access">{c(['Request access', 'اطلب الوصول'])}</Link></div>
      </header>
      {children}
      <footer className="mk-footer">
        <div><Link href="/">Resuto</Link><span>© {new Date().getFullYear()} Resuto</span></div>
        <nav>
          <Link href="/privacy/">{c(['Privacy', 'الخصوصية'])}</Link>
          <Link href="/terms/">{c(['Terms', 'الشروط'])}</Link>
          <a href="mailto:contact@resuto.app">contact@resuto.app</a>
        </nav>
      </footer>
    </div>
  );
}

export function BilingualPage({ eyebrow, title, intro, children }: {
  eyebrow: readonly [string, string]; title: readonly [string, string]; intro: readonly [string, string]; children: (ar: boolean) => ReactNode;
}) {
  const { locale } = useT();
  const ar = locale === 'ar';
  return <PublicShell><main className="mk-main"><header className="mk-hero"><span>{eyebrow[ar ? 1 : 0]}</span><h1>{title[ar ? 1 : 0]}</h1><p>{intro[ar ? 1 : 0]}</p></header>{children(ar)}</main></PublicShell>;
}
