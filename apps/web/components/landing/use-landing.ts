'use client';
import { useEffect, useMemo, useState } from 'react';
import { dictionaries } from '@/lib/i18n';
import { useT } from '@/lib/i18n/client';

/** Landing-page helpers: copy keyed by its English source text (legacy `t()` semantics). */
export function useLanding() {
  const { locale } = useT();
  const rtl = locale === 'ar';
  const reduced = useReducedMotionFlag();
  return useMemo(() => {
    const dict = dictionaries[locale];
    const l = (s: string) => dict[`platform.lp.${s}`] ?? s;
    const nf = new Intl.NumberFormat(rtl ? 'ar-EG' : 'en-US');
    const num = (n: number) => nf.format(n);
    const mf = new Intl.NumberFormat(rtl ? 'ar-EG' : 'en-EG', { style: 'currency', currency: 'EGP', maximumFractionDigits: 2 });
    const money = (minor: number) => mf.format(minor / 100);
    const clock = (h: number, m: number) => new Date(2024, 0, 1, h, m).toLocaleTimeString(rtl ? 'ar-EG' : 'en-US', { hour: 'numeric', minute: '2-digit' });
    return { locale, rtl, l, num, money, clock, arrow: rtl ? '←' : '→', reduced };
  }, [locale, rtl, reduced]);
}
export type Landing = ReturnType<typeof useLanding>;

/** prefers-reduced-motion, read once on mount (the legacy page reloads when it changes). */
export function useReducedMotionFlag() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = () => window.location.reload();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return reduced;
}

/** Fires once when the element is at least `threshold` visible. */
export function onVisible(el: Element, cb: (visible: boolean) => void, threshold = 0.2) {
  const io = new IntersectionObserver((entries) => { for (const x of entries) cb(x.isIntersecting); }, { threshold });
  io.observe(el);
  return () => io.disconnect();
}
