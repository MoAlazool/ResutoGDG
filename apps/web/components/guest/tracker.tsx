'use client';
// Order status (legacy guest.js statusPage()/timeline()): a card per order with its number and total, the numbered
// horizontal tracker (1 Order received → 2 Preparing → 3 Ready → 4 Served / Picked up / Delivered) and its lines.
import { toWesternDigits } from '@resuto/contracts';
import { useT } from '@/lib/i18n/client';
import { money, pick, time } from '@/lib/format';

const STAGES: Record<string, string[]> = {
  dine_in: ['placed', 'preparing', 'ready', 'served'],
  pickup: ['placed', 'preparing', 'ready', 'picked_up'],
  delivery: ['placed', 'preparing', 'ready', 'delivered'],
};
/** Where an order status sits on its tracker (accepted counts as received). */
const stageOf = (status: string, fulfillment: string) => (STAGES[fulfillment] ?? STAGES.dine_in!).indexOf(status === 'accepted' ? 'placed' : status);

export function OrderTimeline({ status, fulfillment, timeline }: { status: string; fulfillment: string; timeline: Array<{ status: string; at: string | null }> }) {
  const { t, locale } = useT();
  const stages = STAGES[fulfillment] ?? STAGES.dine_in!;
  const index = status === 'awaiting_payment' ? -1 : stageOf(status, fulfillment);
  const label = (s: string) => s === 'placed' ? t('core.guest.step.received') : s === 'ready' && fulfillment === 'pickup' ? t('core.guest.step.readyPickup') : t(`core.guest.step.${s}`);
  const at = (s: string) => [...timeline].reverse().find((e) => (s === 'placed' ? e.status === 'placed' || e.status === 'accepted' : e.status === s))?.at ?? null;
  return (
    <ol className="gx-timeline">
      {stages.map((s, i) => (
        <li key={s} className={i <= index ? 'done' : ''} aria-current={i === index ? 'step' : undefined}>
          <i aria-hidden>{i < index ? '✓' : i + 1}</i>
          <span>{label(s)}</span>
          {i <= index && at(s) && <small>{time(at(s), locale)}</small>}
        </li>
      ))}
    </ol>
  );
}

export interface TrackedOrder {
  id?: string; number: string; status: string; fulfillment: string; totalMinor: number; currency?: string;
  timeline: Array<{ status: string; at: string | null }>;
  lines: Array<{ name: string; nameAr: string | null; quantity: number; modifiers?: string[] }>;
}

export function StatusOrder({ order, currency }: { order: TrackedOrder; currency: string }) {
  const { t, locale } = useT();
  return (
    <article className="gx-status-order">
      <header><strong><bdi dir="ltr" className="num">#{toWesternDigits(String(order.number))}</bdi></strong><span><bdi>{money(order.totalMinor, order.currency ?? currency, locale)}</bdi></span></header>
      {order.status === 'cancelled' ? <p className="gx-note is-danger">{t('core.guest.status.cancelled')}</p>
        : order.status === 'awaiting_payment' ? <p className="gx-note is-warn">{t('core.web.awaitingPayment')}</p>
          : <OrderTimeline status={order.status} fulfillment={order.fulfillment} timeline={order.timeline} />}
      <div>{order.lines.map((l, i) => <p key={i}><bdi>{l.quantity}</bdi> × {pick(locale, l.name, l.nameAr)}{l.modifiers?.length ? <span className="gx-fine"> · {l.modifiers.join(' · ')}</span> : null}</p>)}</div>
    </article>
  );
}

/** The headline over a set of orders: on its way, ready, or enjoy once everything has reached the table. */
export function statusHeadline(orders: Array<{ status: string; fulfillment: string }>, t: (k: string) => string) {
  const live = orders.filter((o) => o.status !== 'cancelled');
  if (live.length && live.every((o) => ['served', 'picked_up', 'delivered'].includes(o.status))) return t('core.guest.status.enjoy');
  if (live.some((o) => o.status === 'ready')) return t('core.guest.status.ready');
  return t('core.guest.status.onItsWay');
}
