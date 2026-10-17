'use client';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Badge, type Tone } from './base';
import { UiStyles } from './styles';
import type { UiLocale } from './overlays';

// --- Locale-aware numbers and money --------------------------------------------
/** Minor-unit exponent per currency (EGP/SAR/USD use 2). */
const MINOR_DIGITS: Record<string, number> = { EGP: 2, SAR: 2, USD: 2, KWD: 3, BHD: 3, JPY: 0 };
const intlLocale = (locale: UiLocale) => (locale === 'ar' ? 'ar-EG' : 'en-EG');

/** Formats integer minor units like @resuto/contracts formatMoney (no float maths on totals; display only). */
export function formatMinor(minor: number, currency: string, locale: UiLocale = 'en'): string {
  const digits = MINOR_DIGITS[currency] ?? 2;
  return new Intl.NumberFormat(intlLocale(locale), {
    style: 'currency', currency,
    minimumFractionDigits: minor % 10 ** digits === 0 ? 0 : digits, maximumFractionDigits: digits,
  }).format(minor / 10 ** digits);
}

export function useMoneyFormat(locale: UiLocale, currency: string) {
  return useMemo(() => (minor: number | null | undefined) => (minor === null || minor === undefined ? '—' : formatMinor(minor, currency, locale)), [locale, currency]);
}

export function useNumberFormat(locale: UiLocale, options?: Intl.NumberFormatOptions) {
  const key = JSON.stringify(options ?? {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nf = useMemo(() => new Intl.NumberFormat(locale === 'ar' ? 'ar-EG' : 'en-US', options), [locale, key]);
  return (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : nf.format(n));
}

/** Money amount with tabular digits; negative values are marked for colour. */
export function Money({ minor, currency, locale = 'en', className }: { minor: number | null | undefined; currency: string; locale?: UiLocale; className?: string }) {
  const text = minor === null || minor === undefined ? '—' : formatMinor(minor, currency, locale);
  return <span className={['num', className].filter(Boolean).join(' ')} data-negative={(minor ?? 0) < 0 || undefined} dir="ltr" style={{ unicodeBidi: 'isolate' }}>{text}</span>;
}

// --- Status badges ------------------------------------------------------------------
type StatusMap = Record<string, { tone: Tone; en: string; ar: string }>;
export const ORDER_STATUS_BADGES: StatusMap = {
  awaiting_payment: { tone: 'pay', en: 'Awaiting payment', ar: 'بانتظار الدفع' },
  placed: { tone: 'info', en: 'New', ar: 'جديد' },
  accepted: { tone: 'info', en: 'Accepted', ar: 'مقبول' },
  preparing: { tone: 'warn', en: 'Preparing', ar: 'قيد التحضير' },
  ready: { tone: 'ok', en: 'Ready', ar: 'جاهز' },
  served: { tone: 'neutral', en: 'Served', ar: 'تم التقديم' },
  picked_up: { tone: 'neutral', en: 'Picked up', ar: 'تم الاستلام' },
  delivered: { tone: 'neutral', en: 'Delivered', ar: 'تم التوصيل' },
  cancelled: { tone: 'danger', en: 'Cancelled', ar: 'ملغي' },
};
export const PAYMENT_STATUS_BADGES: StatusMap = {
  unpaid: { tone: 'warn', en: 'Unpaid', ar: 'غير مدفوع' },
  pending: { tone: 'pay', en: 'Payment pending', ar: 'الدفع قيد الانتظار' },
  partially_paid: { tone: 'pay', en: 'Partly paid', ar: 'مدفوع جزئيًا' },
  paid: { tone: 'ok', en: 'Paid', ar: 'مدفوع' },
  partially_refunded: { tone: 'info', en: 'Partly refunded', ar: 'مسترد جزئيًا' },
  refunded: { tone: 'neutral', en: 'Refunded', ar: 'مسترد' },
  failed: { tone: 'danger', en: 'Failed', ar: 'فشل' },
};
export const DELIVERY_STATUS_BADGES: StatusMap = {
  unassigned: { tone: 'warn', en: 'Needs a driver', ar: 'بحاجة إلى سائق' },
  offered: { tone: 'info', en: 'Offered', ar: 'تم العرض' },
  assigned: { tone: 'info', en: 'Assigned', ar: 'تم التعيين' },
  accepted: { tone: 'info', en: 'Driver accepted', ar: 'قبل السائق' },
  picked_up: { tone: 'warn', en: 'Picked up', ar: 'تم الاستلام' },
  en_route: { tone: 'warn', en: 'On the way', ar: 'في الطريق' },
  delivered: { tone: 'ok', en: 'Delivered', ar: 'تم التوصيل' },
  failed: { tone: 'danger', en: 'Failed', ar: 'فشل' },
  cancelled: { tone: 'neutral', en: 'Cancelled', ar: 'ملغي' },
};
export const RESERVATION_STATUS_BADGES: StatusMap = {
  held: { tone: 'neutral', en: 'Held', ar: 'محجوز مؤقتًا' },
  pending_deposit: { tone: 'pay', en: 'Deposit pending', ar: 'بانتظار العربون' },
  confirmed: { tone: 'ok', en: 'Confirmed', ar: 'مؤكد' },
  seated: { tone: 'info', en: 'Seated', ar: 'تم الإجلاس' },
  completed: { tone: 'neutral', en: 'Completed', ar: 'مكتمل' },
  cancelled: { tone: 'danger', en: 'Cancelled', ar: 'ملغي' },
  no_show: { tone: 'danger', en: 'No-show', ar: 'لم يحضر' },
  expired: { tone: 'neutral', en: 'Expired', ar: 'منتهي' },
};
const MAPS = { order: ORDER_STATUS_BADGES, payment: PAYMENT_STATUS_BADGES, delivery: DELIVERY_STATUS_BADGES, reservation: RESERVATION_STATUS_BADGES };
export type StatusKind = keyof typeof MAPS;

export function statusLabel(kind: StatusKind, status: string, locale: UiLocale = 'en') {
  const m = MAPS[kind][status];
  return m ? m[locale] : status.replaceAll('_', ' ');
}

/** Consistent colour + wording for order, payment, delivery and reservation states. */
export function StatusBadge({ kind, status, locale = 'en' }: { kind: StatusKind; status: string; locale?: UiLocale }) {
  const m = MAPS[kind][status];
  return <Badge tone={m?.tone ?? 'neutral'}>{statusLabel(kind, status, locale)}</Badge>;
}

// --- Timeline and key/value list ---------------------------------------------------------
export interface TimelineItem { id: string; title: ReactNode; time?: string; timeLabel?: ReactNode; description?: ReactNode; tone?: 'ok' | 'warn' | 'info' | 'danger' | 'pay' | 'neutral' }
export function Timeline({ items, empty }: { items: TimelineItem[]; empty?: ReactNode }) {
  if (!items.length) return <>{empty ?? null}</>;
  return (
    <ol className="rui-timeline">
      <UiStyles />
      {items.map((i) => (
        <li key={i.id}>
          <span className="rui-dot" data-tone={i.tone ?? 'neutral'} aria-hidden />
          <div>
            <strong>{i.title}</strong>
            {(i.time || i.timeLabel) && <time dateTime={i.time}>{i.timeLabel ?? i.time}</time>}
            {i.description && <div><small>{i.description}</small></div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function KeyValueList({ items, className }: { items: Array<{ label: ReactNode; value: ReactNode; key?: string }>; className?: string }) {
  return (
    <dl className={['rui-kv', className].filter(Boolean).join(' ')}>
      <UiStyles />
      {items.map((i, n) => (
        <div key={i.key ?? n} style={{ display: 'contents' }}>
          <dt>{i.label}</dt>
          <dd>{i.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

// --- Accessibility helpers -----------------------------------------------------------------
/** True when the user asked the OS to minimise motion (auto-playing demos must pause). */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    const on = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return reduced;
}

export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className="sr-only">{children}</span>;
}
