'use client';
// Resuto marketing landing page: a React port of legacy/public/landing.js and its
// demo modules, with the same layout, copy, imagery, interactions and animations.
import { useEffect, useRef } from 'react';
import { useT } from '@/lib/i18n/client';
import '../floor/floor.css';
import { BillDemo, ManagerDemo } from './BillManagerDemos';
import { Connect, Cta, Footer, Nav, Pricing, SystemBand, type LandingPlan } from './Chrome';
import { Hero } from './Hero';
import { ImportDemo } from './ImportDemo';
import { KitchenDemo } from './KitchenDemo';
import { ReserveDemo } from './ReserveDemo';
import { ServiceDemo } from './ServiceDemo';
import { StudioDemo } from './StudioDemo';
import { useLanding } from './use-landing';
import './landing.css';

export function LandingPage({ plans }: { plans: LandingPlan[] | null }) {
  const L = useLanding();
  const { t } = useT();
  const root = useRef<HTMLDivElement>(null);

  // Scroll reveals (staggered among siblings), as in the legacy page.
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      for (const x of entries) if (x.isIntersecting) { x.target.classList.add('is-in'); io.unobserve(x.target); }
    }, { rootMargin: '0px 0px -10%', threshold: 0.12 });
    el.querySelectorAll<HTMLElement>('[data-reveal]').forEach((r) => {
      const kin = [...(r.parentElement?.children ?? [])].filter((c) => c.hasAttribute('data-reveal'));
      r.style.setProperty('--r', String(kin.indexOf(r)));
      io.observe(r);
    });
    return () => io.disconnect();
  }, []);

  return (
    <div className="lp" ref={root}>
      <a className="skip-link" href="#lp-main">{L.rtl ? 'تخطَّ إلى المحتوى' : 'Skip to content'}</a>
      <Nav L={L} />
      <main className="lp-main" id="lp-main">
        <Hero L={L} />
        <SystemBand L={L} />
        <StudioDemo L={L} />
        <ReserveDemo L={L} />
        <ImportDemo L={L} />
        <ServiceDemo L={L} />
        <KitchenDemo L={L} />
        <BillDemo L={L} />
        <ManagerDemo L={L} />
        <Connect L={L} />
        <Pricing L={L} plans={plans} ownT={t} />
        <Cta L={L} ownT={t} />
      </main>
      <Footer L={L} ownT={t} />
    </div>
  );
}
