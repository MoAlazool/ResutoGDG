import { Injectable } from '@nestjs/common';
import { formatMoney } from '@resuto/contracts';
import { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { OnDomainEvent, type OutboxEvent } from '../../common/events/events';
import { copy, type CopyKey, type Locale } from './bot-copy';
import { MessagingService } from './messaging.service';
import { OrderingService } from './ordering.service';

/** Approved utility template used outside the 24h window: body "… {{1}} … {{2}}" (order number, status text). */
export const ORDER_UPDATE_TEMPLATE = 'order_update';
export const RESERVATION_TEMPLATE = 'reservation_update';

const STATUS_COPY: Record<string, CopyKey> = {
  accepted: 'status_accepted', preparing: 'status_preparing', picked_up: 'status_picked_up', delivered: 'status_delivered', cancelled: 'status_cancelled',
};

/**
 * Customer notifications for orders/deliveries/reservations that belong to a
 * WhatsApp conversation. Transactional only (no marketing consent needed), and
 * subject to the 24-hour window via MessagingService.enqueueToCustomer.
 */
@Injectable()
export class ConnectEventsService {
  constructor(private readonly db: DbService, private readonly messaging: MessagingService, private readonly ordering: OrderingService) {}

  private async orderContext(tx: Tx, orderId: string) {
    return tx.maybeOne<{ id: string; number: string; total_minor: number; currency: string; fulfillment: string; status: string; conversation_id: string | null;
      locale: Locale | null; payment_method: string | null }>(
      `select o.id, o.number, o.total_minor, o.currency, o.fulfillment, o.status, o.conversation_id, c.locale,
              (select s.state->>'paymentMethod' from ordering_sessions s where s.order_id = o.id limit 1) as payment_method
         from orders o left join conversations c on c.id = o.conversation_id where o.id = $1`, [orderId]);
  }

  private async notify(orgId: string, orderId: string, build: (o: NonNullable<Awaited<ReturnType<ConnectEventsService['orderContext']>>>, l: Locale) => { key: CopyKey; vars?: Record<string, string> } | null, reason: string) {
    return this.db.withTenant(orgId, async (tx) => {
      const o = await this.orderContext(tx, orderId);
      if (!o?.conversation_id) return { skipped: 'no_conversation' };
      const l: Locale = o.locale ?? 'en';
      const msg = build(o, l);
      if (!msg) return { skipped: 'not_applicable' };
      const text = copy(l, msg.key, { number: o.number, ...msg.vars });
      const ctx = TenantContext.system(orgId, 'connect.notifications');
      return this.messaging.enqueueToCustomer(tx, ctx, { orderId, text, templateName: ORDER_UPDATE_TEMPLATE,
        variables: { '1': o.number, '2': text }, reason });
    }, 'connect.notifications');
  }

  @OnDomainEvent('connect.order-placed', 'order.placed')
  async orderPlaced(e: OutboxEvent) {
    if (!e.orgId) return;
    return this.notify(e.orgId, e.aggregateId, (o, l) => {
      if (o.status === 'awaiting_payment') return null; // the pay link was already sent by the ordering flow
      const total = formatMoney(o.total_minor, o.currency as 'EGP', l);
      if (o.payment_method === 'cod') return { key: o.fulfillment === 'delivery' ? 'orderReceivedCod' : 'orderReceivedPickup', vars: { total } };
      return { key: 'orderReceived', vars: { total } };
    }, 'order.placed');
  }

  @OnDomainEvent('connect.order-paid', 'order.paid')
  async orderPaid(e: OutboxEvent) {
    if (!e.orgId) return;
    await this.db.withTenant(e.orgId, (tx) => this.ordering.markPaid(tx, e.aggregateId), 'connect.notifications');
    return this.notify(e.orgId, e.aggregateId, () => ({ key: 'orderPaid' }), 'order.paid');
  }

  @OnDomainEvent('connect.order-status', 'order.status_changed', 'order.cancelled')
  async orderStatus(e: OutboxEvent) {
    if (!e.orgId) return;
    const to = String(e.payload?.to ?? (e.type === 'order.cancelled' ? 'cancelled' : ''));
    return this.notify(e.orgId, e.aggregateId, (o) => {
      if (to === 'placed') return null; // awaiting_payment → placed is announced by order.paid
      if (to === 'ready') return { key: o.fulfillment === 'pickup' ? 'status_ready_pickup' : 'status_ready' };
      const key = STATUS_COPY[to];
      return key ? { key } : null;
    }, `order.${to}`);
  }

  /** D2 publishes delivery.status_changed; the payload carries orderId and the new status (re-read from delivery_jobs otherwise). */
  @OnDomainEvent('connect.delivery-status', 'delivery.status_changed')
  async deliveryStatus(e: OutboxEvent) {
    if (!e.orgId) return;
    const job = await this.db.withTenant(e.orgId, (tx) => tx.maybeOne<{ order_id: string; status: string }>(
      `select order_id, status::text from delivery_jobs where id = $1 or order_id = $2 limit 1`, [e.aggregateId, e.payload?.orderId ?? null]), 'connect.notifications')
      .catch(() => null);
    const orderId = (e.payload?.orderId as string | undefined) ?? job?.order_id;
    const status = String(e.payload?.to ?? e.payload?.status ?? job?.status ?? '');
    if (!orderId || !['picked_up', 'en_route'].includes(status)) return { skipped: 'not_applicable' };
    return this.notify(e.orgId, orderId, () => ({ key: 'delivery_on_the_way' }), 'delivery.status_changed');
  }

  @OnDomainEvent('connect.reservation-confirmed', 'reservation.confirmed')
  async reservationConfirmed(e: OutboxEvent) {
    if (!e.orgId) return;
    const orgId = e.orgId;
    return this.db.withTenant(orgId, async (tx) => {
      const r = await tx.maybeOne<{ customer_id: string | null; guest_phone: string | null; party_size: number; starts_at: Date; code: string; tz: string }>(
        `select r.customer_id, r.guest_phone, r.party_size, r.starts_at, r.code, coalesce(b.timezone, o.timezone) as tz
           from reservations r join branches b on b.id = r.branch_id join organizations o on o.id = r.org_id where r.id = $1`, [e.aggregateId]);
      if (!r) return { skipped: 'not_found' };
      const conv = await tx.maybeOne<{ locale: Locale }>(
        `select locale from conversations where org_id = $1 and (($2::uuid is not null and customer_id = $2) or ($3::text is not null and external_contact = $3))
          order by last_inbound_at desc nulls last limit 1`, [orgId, r.customer_id, r.guest_phone?.replace(/^\+/, '') ?? null]);
      if (!conv) return { skipped: 'no_channel' };
      const when = new Intl.DateTimeFormat(conv.locale === 'ar' ? 'ar-EG' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: r.tz }).format(new Date(r.starts_at));
      const text = copy(conv.locale, 'reservationConfirmed', { party: r.party_size, when, code: r.code });
      return this.messaging.enqueueToCustomer(tx, TenantContext.system(orgId, 'connect.notifications'), {
        customerId: r.customer_id, phone: r.guest_phone, text, templateName: RESERVATION_TEMPLATE, variables: { '1': when, '2': r.code }, reason: 'reservation.confirmed' });
    }, 'connect.notifications');
  }
}
