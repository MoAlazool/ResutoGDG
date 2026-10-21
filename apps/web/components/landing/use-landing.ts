'use client';
import { INTL_LOCALE } from '@resuto/contracts';
import { useEffect, useMemo, useState, type RefObject } from 'react';
import { platform } from '@/lib/i18n/dict/platform';
import { useT } from '@/lib/i18n/client';

/** Landing-page helpers: copy keyed by its English source text (legacy `t()` semantics). */
export function useLanding() {
  const { locale } = useT();
  const rtl = locale === 'ar';
  const reduced = useReducedMotionFlag();
  return useMemo(() => {
    // Only the platform dictionary (it holds platform.lp.*): importing `dictionaries` bundled every module's copy,
    // in both languages, into the landing and pricing pages.
    const dict: Record<string, string> = platform[locale];
    const l = (s: string) => dict[`platform.lp.${s}`] ?? s;
    const nf = new Intl.NumberFormat(rtl ? INTL_LOCALE.ar : 'en-US');
    const num = (n: number) => nf.format(n);
    const mf = new Intl.NumberFormat(rtl ? INTL_LOCALE.ar : 'en-EG', { style: 'currency', currency: 'EGP', maximumFractionDigits: 2 });
    const money = (minor: number) => mf.format(minor / 100);
    const clock = (h: number, m: number) => new Date(2024, 0, 1, h, m).toLocaleTimeString(rtl ? INTL_LOCALE.ar : 'en-US', { hour: 'numeric', minute: '2-digit' });
    return { locale, rtl, l, num, money, clock, arrow: rtl ? '←' : '→', reduced };
  }, [locale, rtl, reduced]);
}
export type Landing = ReturnType<typeof useLanding>;

/**
 * The page's scroll reveal adds "is-in" to [data-reveal] elements directly. A demo that also sets its own className
 * (is-live, is-settled) would wipe that class on its next render, and everything keyed on ".is-in" (the KPI
 * sparklines, VP-13) would vanish again. This keeps " is-in" in the rendered className once the page has added it.
 */
export function useKeepReveal(ref: RefObject<HTMLElement | null>): string {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.classList.contains('is-in')) { setShown(true); return; }
    const mo = new MutationObserver(() => { if (el.classList.contains('is-in')) { setShown(true); mo.disconnect(); } });
    mo.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, [ref]);
  return shown ? ' is-in' : '';
}

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
