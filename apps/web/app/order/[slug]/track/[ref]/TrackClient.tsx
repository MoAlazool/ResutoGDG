'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, ApiRequestError } from '@/lib/api';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { RatingSheet } from '@/components/guest/rating';
import { ConsumerFooter, ConsumerHeader, MoneyRow, useToast, type ShellOrg } from '@/components/guest/shell';
import { StatusOrder, statusHeadline } from '@/components/guest/tracker';

interface Tracked {
  number: string; status: string; paymentStatus: string; fulfillment: string; currency: string; totalMinor: number; dueMinor: number;
  deliveryFeeMinor: number; lines: Array<{ name: string; nameAr: string | null; quantity: number; lineTotalMinor: number; modifiers: string[] }>;
  timeline: Array<{ status: string; at: string | null }>;
}

/** Polled every 5 s while visible (no customer contact data is returned); rating once paid or handed over. */
export function TrackClient({ slug, orderRef, org }: { slug: string; orderRef: string; org: ShellOrg | null }) {
  const { t, locale } = useT();
  const [order, setOrder] = useState<Tracked | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rating, setRating] = useState(false);
  const [rated, setRated] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let live = true;
    const load = () => api<Tracked>(`/public/order/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderRef)}`)
      .then((o) => { if (live) { setOrder(o); setError(null); } })
      .catch((e) => { if (live) setError((e as ApiRequestError).message); });
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 5000);
    return () => { live = false; clearInterval(timer); };
  }, [slug, orderRef]);

  const done = !!order && (order.paymentStatus === 'paid' || ['picked_up', 'delivered'].includes(order.status));
  return (
    <div className="gx">
      <ConsumerHeader org={org} menuHref={`/order/${slug}`} reserveHref={null} />
      <main className="gx-main gx-status-page">
        <span className="gx-overline">{t('core.guest.status.overline')}</span>
        <h1>{order ? statusHeadline([order], t) : t('core.guest.shell.loading')}</h1>
        {error && <p className="gx-note is-danger" role="alert">{error}</p>}
        {order && (
          <>
            <StatusOrder order={{ ...order, id: orderRef }} currency={order.currency} />
            {order.deliveryFeeMinor > 0 && <MoneyRow fine label={t('core.bill.delivery')} value={money(order.deliveryFeeMinor, order.currency, locale)} />}
            {order.dueMinor > 0 && order.status !== 'cancelled' && (
              <MoneyRow label={order.fulfillment === 'delivery' ? t('core.web.payOnDelivery') : t('core.web.payAtPickup')} value={money(order.dueMinor, order.currency, locale)} />
            )}
          </>
        )}
        <div className="gx-status-actions" style={{ marginTop: 18 }}>
          <Link className="gx-btn" href={`/order/${slug}`}>{t('core.guest.browse')}</Link>
          {done && !rated && <button type="button" className="gx-btn is-primary" onClick={() => setRating(true)}>{t('core.guest.rate.open')}</button>}
          {rated && <span className="gx-fine">{t('core.guest.rate.done')}</span>}
        </div>
      </main>
      <ConsumerFooter org={org} />
      {rating && (
        <RatingSheet endpoint={`/public/order/${encodeURIComponent(slug)}/orders/${encodeURIComponent(orderRef)}/rating`} onClose={() => setRating(false)}
          onDone={() => { setRating(false); setRated(true); toast.show(t('core.guest.rate.thanks')); }} />
      )}
      {toast.node}
    </div>
  );
}
