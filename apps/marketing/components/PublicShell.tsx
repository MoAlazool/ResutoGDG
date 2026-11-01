'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '@/lib/i18n/client';
import { Switcher, Wordmark } from '../../web/components/landing/Chrome';
import '../../web/components/landing/landing.css';
import './marketing.css';

const nav = [
  ['/', ['Home', 'الرئيسية']],
  ['/pricing/', ['Pricing', 'الأسعار']],
  ['/about/', ['About', 'عن ريسوتو']],
  ['/contact/', ['Contact', 'تواصل معنا']],
] as const;

export function PublicShell({ children }: { children: ReactNode }) {
  const { locale } = useT();
  const ar = locale === 'ar';
  const c = (pair: readonly [string, string]) => pair[ar ? 1 : 0];
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = root.current;
    if (!host) return;
    const reveal = host.querySelectorAll<HTMLElement>('[data-mk-reveal]');
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) {
      reveal.forEach((node) => node.classList.add('is-in'));
      return;
    }
    const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (entry.isIntersecting) { entry.target.classList.add('is-in'); observer.unobserve(entry.target); }
    }), { rootMargin: '0px 0px -8%', threshold: .1 });
    reveal.forEach((node, index) => { node.style.setProperty('--mk-delay', `${Math.min(index % 4, 3) * 70}ms`); observer.observe(node); });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    document.body.classList.toggle('lp-locked', open);
    return () => document.body.classList.remove('lp-locked');
  }, [open]);

  return (
    <div className="lp mk-shell" ref={root}>
      <a className="skip-link" href="#mk-main">{c(['Skip to content', 'تخطَّ إلى المحتوى'])}</a>
      <header className="lp-nav is-stuck mk-nav" id="mk-nav">
        <div className="lp-nav-inner">
          <Link className="lp-logo" href="/" aria-label="Resuto"><Wordmark rtl={ar} /></Link>
          <nav className="lp-nav-links mk-nav-links" aria-label={c(['Main navigation', 'التنقل الرئيسي'])}>
            {nav.map(([href, label]) => <Link key={href} href={href}>{c(label)}</Link>)}
          </nav>
          <div className="lp-nav-end">
            <Switcher L={{ rtl: ar } as never} />
            <Link className="lp-btn lp-btn-solid" href="/contact/?subject=request-access"><span className="lp-cta-long">{c(['Request access', 'اطلب الوصول'])}</span><span className="lp-cta-short">{c(['Contact', 'تواصل'])}</span></Link>
            <button type="button" className="lp-burger" aria-expanded={open} aria-controls="mk-drawer" aria-label={c(['Menu', 'القائمة'])} onClick={() => setOpen((value) => !value)}><i /><i /></button>
          </div>
        </div>
      </header>
      <div className="lp-drawer mk-drawer" id="mk-drawer" hidden={!open}>
        <nav>{nav.map(([href, label]) => <Link key={href} href={href} onClick={() => setOpen(false)}>{c(label)}</Link>)}</nav>
        <Link className="lp-btn lp-btn-solid" href="/contact/?subject=request-access" onClick={() => setOpen(false)}>{c(['Request access', 'اطلب الوصول'])}</Link>
      </div>
      {children}
      <footer className="lp-foot mk-footer">
        <div className="lp-shell lp-foot-grid">
          <div className="lp-foot-brand"><Link className="lp-logo" href="/"><Wordmark rtl={ar} /></Link><p>{c(['A connected restaurant operating environment, built around one live floor and the teams who run it.', 'بيئة تشغيل مترابطة تجمع تجربة الضيف وفريق المطعم حول صالة واحدة حية.'])}</p><a className="lp-foot-email" href="mailto:contact@resuto.app"><span>{c(['Talk to Resuto', 'تواصل معنا'])}</span><strong>contact@resuto.app</strong></a></div>
          <div className="lp-foot-navs">
            <nav aria-label={c(['Product', 'المنتج'])}><h4>{c(['Product', 'المنتج'])}</h4><Link href="/#studio">{c(['Floor Studio', 'استوديو الصالة'])}</Link><Link href="/#service">{c(['Guest service', 'خدمة الضيوف'])}</Link><Link href="/#operations">{c(['Operations', 'التشغيل'])}</Link><Link href="/#connect">{c(['Ecosystem & integrations', 'المنظومة والتكاملات'])}</Link></nav>
            <nav aria-label={c(['Company', 'الشركة'])}><h4>{c(['Company', 'الشركة'])}</h4><Link href="/about/">{c(['About Resuto', 'عن ريسوتو'])}</Link><Link href="/contact/">{c(['Contact', 'تواصل معنا'])}</Link><Link href="/pricing/">{c(['Pricing', 'الأسعار'])}</Link><Link href="/contact/?subject=request-access">{c(['Request access', 'اطلب الوصول'])}</Link></nav>
            <nav aria-label={c(['Legal', 'قانوني'])}><h4>{c(['Legal', 'قانوني'])}</h4><Link href="/privacy/">{c(['Privacy policy', 'سياسة الخصوصية'])}</Link><Link href="/terms/">{c(['Terms', 'الشروط'])}</Link><a href="mailto:founder@resuto.app">{c(['Business contact', 'تواصل الأعمال'])}</a></nav>
          </div>
          <div className="lp-foot-legal"><small>© {new Date().getFullYear()} Resuto</small><small>{c(['Top Handles LLC is Resuto’s business contact; incorporated in Wyoming, USA in 2025, with operations coordinated from Egypt.', 'توب هاندلز ذ.م.م. هي جهة التواصل التجاري لريسوتو؛ تأسست في وايومنغ، الولايات المتحدة عام 2025، وتنسّق أعمالها من مصر.'])}</small></div>
        </div>
      </footer>
    </div>
  );
}

export function BilingualPage({ eyebrow, title, intro, children }: {
  eyebrow: readonly [string, string]; title: readonly [string, string]; intro: readonly [string, string]; children: (ar: boolean) => ReactNode;
}) {
  const { locale } = useT();
  const ar = locale === 'ar';
  return <PublicShell><main className="mk-main" id="mk-main"><header className="mk-hero" data-mk-reveal><span>{eyebrow[ar ? 1 : 0]}</span><h1>{title[ar ? 1 : 0]}</h1><p>{intro[ar ? 1 : 0]}</p></header>{children(ar)}</main></PublicShell>;
}
