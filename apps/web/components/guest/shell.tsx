'use client';
// The consumer shell of the original Resuto guest app (legacy guest.js header()/shell(), platform.css): restaurant
// wordmark with its branch line, Menu / Reservations / language, the editorial cover, sheets, toasts and money rows.
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { pick } from '@/lib/format';
import './consumer.css';

export interface ShellOrg { name: string; nameAr: string | null; slug?: string | null }

/** Legacy consumer-header: the restaurant name set in Georgia over its branch, then Menu · Reservations · language. */
export function ConsumerHeader({ org, branch, menuHref, reserveHref, extra }: {
  org: ShellOrg | null; branch?: { name: string; nameAr: string | null } | null; menuHref?: string | null; reserveHref?: string | null; extra?: ReactNode;
}) {
  const { t, locale } = useT();
  const name = org ? pick(locale, org.name, org.nameAr) : '';
  return (
    <header className="gx-header">
      {org?.slug ? (
        <Link className="gx-logo" href={`/r/${org.slug}`} aria-label={t('core.guest.shell.home', { name })}>
          <span><strong>{name}</strong>{branch && <small>{pick(locale, branch.name, branch.nameAr)}</small>}</span>
        </Link>
      ) : org ? <span className="gx-logo"><span><strong>{name}</strong>{branch && <small>{pick(locale, branch.name, branch.nameAr)}</small>}</span></span>
        : <span className="gx-logo"><span className="gx-mark" aria-hidden>r</span></span>}
      <nav>
        {menuHref && <Link href={menuHref}>{t('core.guest.shell.menu')}</Link>}
        {reserveHref && <Link href={reserveHref}>{t('core.guest.shell.reservations')}</Link>}
        {extra}
        <LanguageToggle />
      </nav>
    </header>
  );
}

export function ConsumerFooter({ org }: { org: ShellOrg | null }) {
  const { t, locale } = useT();
  return (
    <footer className="gx-footer">
      <span>{org ? `${pick(locale, org.name, org.nameAr)} · ` : ''}{t('core.guest.shell.photos')}</span>
      <Link href="/">{t('core.guest.poweredBy')}</Link>
    </footer>
  );
}

/**
 * Legacy menu-cover: the dining-room photograph darkened, an overline and the Georgia headline. The image is the
 * page's largest paint, so it is requested at high priority with its intrinsic size reserved (PCL-08).
 */
export function Cover({ overline, title, body }: { overline: ReactNode; title: ReactNode; body: ReactNode }) {
  return (
    <section className="gx-cover">
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand photo; explicit size, high priority */}
      <img src="/brand/olive-interior.webp" alt="" width={1600} height={900} fetchPriority="high" decoding="async" />
      <div>
        <span className="gx-overline">{overline}</span>
        <h1>{title}</h1>
        <p>{body}</p>
      </div>
    </section>
  );
}

/** A dish photo with its box reserved (square), or the restaurant initial when there is no photo. */
export function Photo({ src, name, size, eager, className = '' }: { src: string | null; name: string; size: number; eager?: boolean; className?: string }) {
  if (!src) return <span className={`gx-photo is-empty ${className}`} aria-hidden>{name.trim().charAt(0).toUpperCase() || '·'}</span>;
  // eslint-disable-next-line @next/next/no-img-element -- tenant media from the API (signed URL); width/height keep CLS at 0
  return <img className={`gx-photo ${className}`} src={src} alt="" width={size} height={size} loading={eager ? 'eager' : 'lazy'} decoding="async" />;
}

/** Legacy guest-sheet: a modal sheet (bottom sheet on phones) with a title and Close. Escape closes it. */
export function Sheet({ title, onClose, children, chat, labelledBy }: { title: ReactNode; onClose: () => void; children: ReactNode; chat?: boolean; labelledBy?: string }) {
  const { t } = useT();
  const ref = useRef<HTMLElement | null>(null);
  const titleId = labelledBy ?? 'gx-sheet-title';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = overflow; previous?.focus?.(); };
  }, [onClose]);
  return (
    <div className="gx-backdrop" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <section ref={ref} tabIndex={-1} className={`gx-sheet${chat ? ' is-chat' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="gx-sheet-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="gx-sheet-close" onClick={onClose}>{t('action.close')}</button>
        </div>
        {children}
      </section>
    </div>
  );
}

export function MoneyRow({ label, value, grand, fine }: { label: ReactNode; value: ReactNode; grand?: boolean; fine?: boolean }) {
  return <div className={`gx-money-row${grand ? ' is-grand' : ''}${fine ? ' is-fine' : ''}`}><span>{label}</span><strong><bdi>{value}</bdi></strong></div>;
}

export function Stepper({ value, onMinus, onPlus, label, large, max = 99 }: {
  value: number; onMinus: () => void; onPlus: () => void; label: string; large?: boolean; max?: number;
}) {
  const { t } = useT();
  return (
    <span className={`gx-stepper${large ? ' is-large' : ''}`} role="group" aria-label={label}>
      <button type="button" onClick={onMinus} aria-label={t('core.guest.less')}>−</button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={onPlus} disabled={value >= max} aria-label={t('core.guest.more')}>+</button>
    </span>
  );
}

/** Legacy #toast: one short message at a time, gone after five seconds. */
export function useToast() {
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(id);
  }, [toast]);
  const show = useCallback((text: string, error = false) => setToast({ text, error }), []);
  const node = toast ? <div role="status" className={`gx-toast${toast.error ? ' is-error' : ''}`}>{toast.text}</div> : null;
  return { show, node };
}

/** The guest-facing message for an API failure (server messages are already plain language). */
export const failureText = (e: unknown) => (e instanceof Error ? e.message : String(e));
