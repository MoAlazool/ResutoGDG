'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Notice, Skeleton } from '@resuto/ui';
import { api } from '@/lib/api';
import { money, pick } from '@/lib/format';
import { LanguageToggle, useT } from '@/lib/i18n/client';
import { StatusTimeline } from '../../../../t/[qr]/_guest/menu-ui';

interface Tracked {
  number: string; status: string; paymentStatus: string; fulfillment: string; currency: string; totalMinor: number; dueMinor: number;
  deliveryFeeMinor: number; lines: Array<{ name: string; nameAr: string | null; quantity: number; lineTotalMinor: number; modifiers: string[] }>;
  timeline: Array<{ status: string; at: string | null }>;
}

/** Public order tracking by its unguessable reference (polled; no customer contact data is returned). */
export default function TrackPage() {
  const { slug, ref } = useParams<{ slug: string; ref: string }>();
  const { t, locale } = useT();
  const [order, setOrder] = useState<Tracked | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => api<Tracked>(`/public/order/${slug}/orders/${ref}`).then((o) => live && setOrder(o)).catch((e) => live && setError((e as Error).message));
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 4000);
    return () => { live = false; clearInterval(timer); };
  }, [slug, ref]);

  return (
    <main className="g-app">
      <div className="g-wrap">
        <header className="g-top"><Link href={`/order/${slug}`} className="btn btn-ghost btn-sm">← {t('core.web.backToMenu')}</Link><LanguageToggle /></header>
        {error && <Notice tone="danger">{error}</Notice>}
        {!order && !error && <Skeleton lines={5} />}
        {order && (
          <section className="g-card rise">
            <div className="overline">{t(`core.web.${order.fulfillment}`)}</div>
            <h1 style={{ fontSize: 26 }}>{t('core.guest.orderNumber', { n: order.number })}</h1>
            {order.status === 'awaiting_payment' && <Notice tone="warn">{t('core.web.awaitingPayment')}</Notice>}
            <StatusTimeline status={order.status} fulfillment={order.fulfillment} timeline={order.timeline} />
            {order.lines.map((l, i) => (
              <div className="g-line" key={i}>
                <span className="num">{l.quantity}×</span>
                <div className="g-line-body">{pick(locale, l.name, l.nameAr)}{l.modifiers.length > 0 && <small>{l.modifiers.join(' · ')}</small>}</div>
                <span className="num">{money(l.lineTotalMinor, order.currency, locale)}</span>
              </div>
            ))}
            <div className="g-totals">
              {order.deliveryFeeMinor > 0 && <div><span>{t('core.bill.delivery')}</span><span>{money(order.deliveryFeeMinor, order.currency, locale)}</span></div>}
              <div className="g-grand"><span>{t('core.bill.total')}</span><span>{money(order.totalMinor, order.currency, locale)}</span></div>
              {order.dueMinor > 0 && <div className="fine"><span>{order.fulfillment === 'delivery' ? t('core.web.payOnDelivery') : t('core.web.payAtPickup')}</span><span>{money(order.dueMinor, order.currency, locale)}</span></div>}
            </div>
          </section>
        )}
      </div>
    </main>
  );
}
