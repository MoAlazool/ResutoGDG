import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  formatMoney, ORDERING_TERMINAL, type OrderAttributionInput, type OrderingCartInput, type OrderingCheckoutInput, type OrderingDetailsInput, type OrderingStep,
} from '@resuto/contracts';
import { TenantContext } from '../../common/auth/context';
import { newToken, sha256 } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, invalid, notFound } from '../../common/errors/domain-error';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { Scheduled } from '../../common/events/events';
import { ENV, type Env } from '../../config/env';
import { OrdersKernelService } from '../kernel/orders-kernel.service';
import { CHECKOUT_PORT, requirePort, type CheckoutPort } from '../kernel/ports';
import { PricingService, type Quote } from '../kernel/pricing.service';
import { copy, textCommand, type Locale } from './bot-copy';
import { HandoffService } from './handoff.service';
import { readPublicMenu } from './menu-read-model';
import { MessagingService, type ConversationRow, type OutboundContent } from './messaging.service';

export const SESSION_TTL_MINUTES = 60;

export interface InboundMessage {
  type: 'text' | 'button_reply' | 'list_reply' | 'location' | 'button' | 'image' | 'other';
  text: string | null;
  replyId: string | null;
  location: { latitude: number; longitude: number; name: string | null; address: string | null } | null;
}

interface CartLine { productId: string; quantity: number; modifiers: Array<{ groupId: string; optionId: string }>; notes?: string | null }
interface OrderingState {
  branchId?: string;
  fulfillment?: 'pickup' | 'delivery';
  customerName?: string;
  address?: { line1: string; area?: string | null; city?: string | null; notes?: string | null; latitude?: number | null; longitude?: number | null };
  marketingConsent?: boolean;
  cart?: CartLine[];
  quote?: ReturnType<typeof quoteSummary>;
  paymentMethod?: 'online' | 'cod';
  order?: { id: string; number: string; publicRef: string; status: string; totalMinor: number; currency: string };
  checkout?: { id: string; url: string; expiresAt: string; amountMinor: number };
}
interface SessionRow {
  id: string; org_id: string; conversation_id: string | null; customer_id: string | null; branch_id: string | null; channel: string;
  step: OrderingStep; state: OrderingState; order_id: string | null; expires_at: Date; version: number; created_at: Date;
}

function quoteSummary(q: Quote) {
  return {
    currency: q.currency, subtotalMinor: q.subtotalMinor, discountMinor: q.discountMinor, deliveryFeeMinor: q.deliveryFeeMinor,
    serviceChargeMinor: q.serviceChargeMinor, taxMinor: q.taxMinor, taxInclusive: q.taxInclusive, totalMinor: q.totalMinor,
    lines: q.lines.map((l) => ({ productId: l.productId, name: l.name, nameAr: l.nameAr, quantity: l.quantity, unitPriceMinor: l.unitPriceMinor,
      modifiers: l.modifiers.map((m) => ({ groupId: m.groupId, optionId: m.optionId, option: m.option, optionAr: m.optionAr, priceDeltaMinor: m.priceDeltaMinor })),
      lineTotalMinor: l.lineTotalMinor, notes: l.notes })),
  };
}

const LIVE = (step: OrderingStep) => !ORDERING_TERMINAL.includes(step);
const guestCtx = (orgId: string, sessionId: string, source: TenantContext['source']) =>
  new TenantContext(orgId, 'admin', null, null, 'guest', `ordering_session:${sessionId}`, source);

/**
 * Structured (OFB-style) WhatsApp ordering. The bot collects branch →
 * fulfillment → name → (address) with interactive replies, then sends a
 * single-use link to the hosted ordering page where the customer picks real
 * menu products. The server prices everything through the kernel; COD orders
 * are placed 'placed', online orders 'awaiting_payment' with a ResutoPay
 * checkout link. Payment success is applied only by verified provider webhooks
 * (ResutoPay → kernel ledger), never by a chat message.
 */
@Injectable()
export class OrderingService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly messaging: MessagingService,
    private readonly handoffs: HandoffService,
    private readonly pricing: PricingService,
    private readonly orders: OrdersKernelService,
    private readonly entitlements: EntitlementsService,
    @Optional() @Inject(CHECKOUT_PORT) private readonly checkoutPort?: CheckoutPort,
  ) {}

  // ---------------------------------------------------------------------------
  // Bot (runs inside the inbound-message transaction)
  // ---------------------------------------------------------------------------
  async handleInbound(tx: Tx, ctx: TenantContext, conv: ConversationRow, msg: InboundMessage) {
    if (conv.status !== 'bot') return; // handoff/open/closed: humans answer
    const locale = conv.locale;
    const command = msg.replyId === 'handoff' ? 'human' : msg.replyId === 'order.cancel' ? 'cancel' : msg.replyId === 'order.restart' ? 'restart'
      : msg.replyId === 'order.start' ? 'start' : msg.type === 'text' ? textCommand(msg.text) : null;
    let session = await this.liveSession(tx, conv.id, true);

    if (command === 'human') {
      await this.handoffs.open(tx, ctx, conv.id, session ? `Customer asked for help at step ${session.step}` : 'Customer asked for a human', null);
      await this.send(tx, conv, { type: 'text', body: copy(locale, 'handoff') });
      return;
    }
    if (!conv.ordering_enabled) {
      await this.send(tx, conv, { type: 'buttons', body: copy(locale, 'unavailable'), buttons: [{ id: 'handoff', title: copy(locale, 'talkToUs') }] });
      return;
    }
    if (session && (command === 'cancel' || command === 'restart')) {
      await this.cancelSession(tx, ctx, session, 'customer');
      if (command === 'cancel') { await this.send(tx, conv, { type: 'text', body: copy(locale, 'cancelled') }); return; }
      session = null;
    }
    if (!session) {
      if (command === 'start' || command === 'restart') {
        const created = await this.startSession(tx, ctx, conv);
        if (created) await this.prompt(tx, conv, created);
        return;
      }
      const org = await tx.one<{ name: string; name_ar: string | null }>(`select name, name_ar from organizations where id = $1`, [conv.org_id]);
      await this.send(tx, conv, {
        type: 'buttons', body: copy(locale, 'welcome', { name: locale === 'ar' && org.name_ar ? org.name_ar : org.name }),
        buttons: [{ id: 'order.start', title: copy(locale, 'orderNow') }, { id: 'handoff', title: copy(locale, 'talkToUs') }],
      });
      return;
    }

    const state = session.state;
    const reply = msg.replyId ?? '';
    switch (session.step) {
      case 'branch': {
        const id = reply.startsWith('branch:') ? reply.slice(7) : null;
        const options = await this.branchOptions(tx, conv);
        const b = options.find((x) => x.id === id);
        if (!b) return this.prompt(tx, conv, session);
        session = await this.save(tx, session, { state: { ...state, branchId: b.id }, branch_id: b.id, step: 'fulfillment' });
        return this.autoAdvance(tx, conv, session);
      }
      case 'fulfillment': {
        const f = reply === 'ful:pickup' ? 'pickup' : reply === 'ful:delivery' ? 'delivery' : null;
        const offered = await this.fulfillmentOptions(tx, session.branch_id!);
        if (!f || !offered.includes(f)) return this.prompt(tx, conv, session);
        session = await this.save(tx, session, { state: { ...state, fulfillment: f }, step: 'customer' });
        return this.prompt(tx, conv, session);
      }
      case 'customer': {
        let name: string | null = null;
        if (reply === 'name:profile' && conv.contact_name) name = conv.contact_name.trim().slice(0, 60);
        else if (msg.type === 'text' && msg.text && !command) name = msg.text.trim().replace(/\s+/g, ' ');
        if (!name || name.length < 2 || name.length > 60) {
          if (msg.type === 'text' && msg.text) await this.send(tx, conv, { type: 'text', body: copy(locale, 'invalidName') });
          return this.prompt(tx, conv, session);
        }
        session = await this.save(tx, session, { state: { ...state, customerName: name }, step: state.fulfillment === 'delivery' ? 'address' : 'menu' });
        return this.prompt(tx, conv, session);
      }
      case 'address': {
        let address: OrderingState['address'] | null = null;
        if (msg.type === 'location' && msg.location) {
          const { latitude, longitude, name, address: a } = msg.location;
          address = { line1: (a || name || `Shared location (${latitude.toFixed(5)}, ${longitude.toFixed(5)})`).slice(0, 300), latitude, longitude };
        } else if (msg.type === 'text' && msg.text && !command && msg.text.trim().length >= 5) {
          address = { line1: msg.text.trim().slice(0, 300) };
        }
        if (!address) {
          if (msg.type === 'text') await this.send(tx, conv, { type: 'text', body: copy(locale, 'invalidAddress') });
          return this.prompt(tx, conv, session);
        }
        session = await this.save(tx, session, { state: { ...state, address }, step: 'menu' });
        return this.prompt(tx, conv, session);
      }
      case 'review': {
        if (reply === 'pay:online' || reply === 'pay:cod') {
          // Savepoint: a business rejection (price changed, sold out, payments unavailable)
          // must not leave partial kernel writes; the customer gets the review again.
          await tx.query('savepoint bot_place');
          try {
            await this.placeOrder(tx, conv, session, reply === 'pay:online' ? 'online' : 'cod', state.quote?.totalMinor ?? 0, undefined, ctx.source);
            await tx.query('release savepoint bot_place');
            return; // COD confirmation comes from the order.placed handler; online already got its pay link
          } catch (e) {
            if (!(e instanceof DomainError)) throw e;
            await tx.query('rollback to savepoint bot_place');
            await this.send(tx, conv, { type: 'text', body: e.message });
            if (e.code === 'price_changed' || e.code === 'out_of_stock' || e.code === 'item_unavailable') {
              session = await this.save(tx, session, { step: 'menu' });
            }
            return this.prompt(tx, conv, session);
          }
        }
        return this.prompt(tx, conv, session);
      }
      default:
        return this.prompt(tx, conv, session); // menu / awaiting_payment: resend the link
    }
  }

  private async startSession(tx: Tx, ctx: TenantContext, conv: ConversationRow): Promise<SessionRow | null> {
    const branches = await this.branchOptions(tx, conv);
    if (!branches.length) {
      await this.send(tx, conv, { type: 'buttons', body: copy(conv.locale, 'unavailable'), buttons: [{ id: 'handoff', title: copy(conv.locale, 'talkToUs') }] });
      return null;
    }
    const session = await tx.one<SessionRow>(
      `insert into ordering_sessions(org_id, conversation_id, customer_id, channel, step, state, token_hash, expires_at)
       values ($1, $2, $3, 'whatsapp', 'branch', '{}'::jsonb, $4, now() + make_interval(mins => $5)) returning *`,
      [ctx.orgId, conv.id, conv.customer_id, sha256(newToken()), SESSION_TTL_MINUTES]);
    if (branches.length === 1) {
      const s = await this.save(tx, session, { state: { branchId: branches[0]!.id }, branch_id: branches[0]!.id, step: 'fulfillment' });
      return this.autoFulfillment(tx, s);
    }
    return session;
  }

  /** After a branch is chosen: skip the fulfillment question when only one option exists. */
  private async autoAdvance(tx: Tx, conv: ConversationRow, session: SessionRow) {
    const s = await this.autoFulfillment(tx, session);
    return this.prompt(tx, conv, s);
  }

  private async autoFulfillment(tx: Tx, session: SessionRow) {
    const offered = await this.fulfillmentOptions(tx, session.branch_id!);
    if (offered.length === 1) return this.save(tx, session, { state: { ...session.state, fulfillment: offered[0]! }, step: 'customer' });
    return session;
  }

  private async branchOptions(tx: Tx, conv: ConversationRow) {
    return tx.query<{ id: string; name: string; name_ar: string | null; address: string | null }>(
      `select id, name, name_ar, address from branches where org_id = $1 and is_active and (accepts_pickup or accepts_delivery)
          and ($2::uuid is null or id = $2) order by created_at limit 10`, [conv.org_id, conv.channel_branch_id]);
  }

  private async fulfillmentOptions(tx: Tx, branchId: string): Promise<Array<'pickup' | 'delivery'>> {
    const b = await tx.one<{ accepts_pickup: boolean; accepts_delivery: boolean }>(`select accepts_pickup, accepts_delivery from branches where id = $1`, [branchId]);
    return [...(b.accepts_pickup ? ['pickup' as const] : []), ...(b.accepts_delivery ? ['delivery' as const] : [])];
  }

  /** Sends the question/link for the session's current step. */
  async prompt(tx: Tx, conv: ConversationRow, session: SessionRow): Promise<void> {
    const l = conv.locale;
    const s = session.state;
    switch (session.step) {
      case 'branch': {
        const options = await this.branchOptions(tx, conv);
        const label = (b: { name: string; name_ar: string | null }) => (l === 'ar' && b.name_ar ? b.name_ar : b.name);
        if (options.length <= 3) {
          await this.send(tx, conv, { type: 'buttons', body: copy(l, 'chooseBranch'), buttons: options.map((b) => ({ id: `branch:${b.id}`, title: label(b) })) });
        } else {
          await this.send(tx, conv, { type: 'list', body: copy(l, 'chooseBranch'), buttonText: copy(l, 'branches'),
            sections: [{ title: copy(l, 'branches'), rows: options.map((b) => ({ id: `branch:${b.id}`, title: label(b), description: b.address })) }] });
        }
        return;
      }
      case 'fulfillment': {
        const offered = await this.fulfillmentOptions(tx, session.branch_id!);
        await this.send(tx, conv, { type: 'buttons', body: copy(l, 'chooseFulfillment'), buttons: offered.map((f) => ({ id: `ful:${f}`, title: copy(l, f) })) });
        return;
      }
      case 'customer':
        if (conv.contact_name && conv.contact_name.trim().length >= 2) {
          await this.send(tx, conv, { type: 'buttons', body: copy(l, 'askName'), buttons: [{ id: 'name:profile', title: copy(l, 'useName', { name: conv.contact_name.trim().slice(0, 12) }) }] });
        } else {
          await this.send(tx, conv, { type: 'text', body: copy(l, 'askName') });
        }
        return;
      case 'address':
        await this.send(tx, conv, { type: 'location_request', body: copy(l, 'askAddress') });
        return;
      case 'menu': {
        // Rotate the page credential each time a link is sent: older links stop working.
        const token = newToken();
        await tx.query(`update ordering_sessions set token_hash = $2 where id = $1`, [session.id, sha256(token)]);
        await this.send(tx, conv, { type: 'cta_url', body: copy(l, 'menuLink', { name: s.customerName ?? '' }), displayText: copy(l, 'openMenu'), url: `${this.env.APP_ORIGIN}/o/${token}` });
        return;
      }
      case 'review': {
        const q = s.quote;
        if (!q) return;
        const money = (m: number) => formatMoney(m, q.currency as 'EGP' | 'SAR', l);
        const lines = q.lines.map((x) => `${x.quantity} × ${l === 'ar' && x.nameAr ? x.nameAr : x.name}${x.modifiers.length ? ` (${x.modifiers.map((m) => (l === 'ar' && m.optionAr) || m.option).join(', ')})` : ''} — ${money(x.lineTotalMinor)}`).join('\n');
        const buttons = [
          ...((await this.onlineAvailable(conv.org_id)) ? [{ id: 'pay:online', title: copy(l, 'payOnline') }] : []),
          { id: 'pay:cod', title: copy(l, s.fulfillment === 'delivery' ? 'payCod' : 'payAtPickup') },
        ];
        await this.send(tx, conv, { type: 'buttons', body: copy(l, 'review', { lines, subtotal: money(q.subtotalMinor), total: money(q.totalMinor),
          delivery: q.deliveryFeeMinor ? copy(l, 'deliveryFee', { fee: money(q.deliveryFeeMinor) }) : '' }), buttons });
        return;
      }
      case 'awaiting_payment':
        if (s.checkout && s.order) {
          await this.send(tx, conv, { type: 'cta_url', body: copy(l, 'stillAwaitingPayment', { number: s.order.number }), displayText: copy(l, 'payNow'), url: s.checkout.url });
        }
        return;
      default:
        return;
    }
  }

  private async send(tx: Tx, conv: ConversationRow, content: OutboundContent) {
    try {
      await this.messaging.enqueue(tx, conv, content, { automated: true, reason: 'bot' });
    } catch (e) {
      // Outside the 24h window the bot cannot reply free-form; that is not an inbound failure.
      if (!(e instanceof DomainError && (e.code === 'outside_window' || e.code === 'channel_disabled'))) throw e;
    }
  }

  private async liveSession(tx: Tx, conversationId: string, lock: boolean): Promise<SessionRow | null> {
    return tx.maybeOne<SessionRow>(
      `select * from ordering_sessions where conversation_id = $1 and step not in ('completed', 'cancelled', 'expired')${lock ? ' for update' : ''}`, [conversationId]);
  }

  /** Optimistic update: bumps version and extends the expiry while the session is live. */
  private async save(tx: Tx, s: SessionRow, patch: { step?: OrderingStep; state?: OrderingState; branch_id?: string; customer_id?: string | null;
    order_id?: string; checkout_session_id?: string; expiresAt?: Date }, expectedVersion = s.version): Promise<SessionRow> {
    const step = patch.step ?? s.step;
    const row = await tx.maybeOne<SessionRow>(
      `update ordering_sessions set step = $3, state = $4, branch_id = coalesce($5, branch_id), customer_id = coalesce($6, customer_id),
          order_id = coalesce($7, order_id), checkout_session_id = coalesce($8, checkout_session_id), version = version + 1,
          expires_at = coalesce($9, case when $10 then expires_at else now() + make_interval(mins => $11) end)
        where id = $1 and version = $2 returning *`,
      [s.id, expectedVersion, step, patch.state ?? s.state, patch.branch_id ?? null, patch.customer_id ?? null, patch.order_id ?? null,
        patch.checkout_session_id ?? null, patch.expiresAt ?? null, !LIVE(step), SESSION_TTL_MINUTES]);
    if (!row) throw new DomainError('stale_session', 'This order was updated elsewhere. Refresh to continue.', 409);
    return row;
  }

  async cancelSession(tx: Tx, ctx: TenantContext, s: SessionRow, by: 'customer' | 'staff') {
    if (s.order_id && s.step === 'awaiting_payment') {
      const o = await tx.maybeOne<{ status: string; paid_minor: number }>(`select status, paid_minor from orders where id = $1`, [s.order_id]);
      if (o?.status === 'awaiting_payment' && !o.paid_minor) await this.orders.transition(tx, ctx, s.order_id, 'cancelled', { reason: `ordering_cancelled_by_${by}` });
    }
    await this.save(tx, s, { step: 'cancelled' });
  }

  // ---------------------------------------------------------------------------
  // Hosted ordering page (/o/:token) — guest bearer token
  // ---------------------------------------------------------------------------
  async resolveToken(token: string): Promise<{ id: string; orgId: string }> {
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw notFound('Ordering session');
    const r = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string; org_id: string }>(`select id, org_id from ordering_sessions where token_hash = $1`, [sha256(token)]));
    if (!r) throw notFound('Ordering session');
    await this.entitlements.assert(r.org_id, 'connect');
    return { id: r.id, orgId: r.org_id };
  }

  private async sessionFor(tx: Tx, id: string, lock = false) {
    const s = await tx.one<SessionRow>(`select * from ordering_sessions where id = $1${lock ? ' for update' : ''}`, [id]);
    const conv = s.conversation_id ? await this.messaging.conversation(tx, s.conversation_id) : null;
    return { s, conv };
  }

  private assertLive(s: SessionRow, allowed: OrderingStep[]) {
    if (s.step === 'expired' || s.step === 'cancelled' || (LIVE(s.step) && new Date(s.expires_at).getTime() < Date.now() && s.step !== 'awaiting_payment')) {
      throw new DomainError('session_expired', 'This ordering link has expired. Message us to start again.', 410);
    }
    if (!allowed.includes(s.step)) throw new DomainError('invalid_step', `This action is not available at step ${s.step}`, 409, { step: s.step });
  }

  async view(token: string) {
    const ref = await this.resolveToken(token);
    return this.db.withTenant(ref.orgId, async (tx) => {
      const { s, conv } = await this.sessionFor(tx, ref.id);
      const expired = s.step === 'expired' || s.step === 'cancelled' || (LIVE(s.step) && s.step !== 'awaiting_payment' && new Date(s.expires_at).getTime() < Date.now());
      const menu = s.branch_id && !expired ? await readPublicMenu(tx, ref.orgId, s.branch_id) : null;
      return { ...(await this.publicView(tx, s, conv)), expired, menu };
    }, `ordering_session:${ref.id}`);
  }

  /** Online payment needs ResutoPay deployed (port bound) AND this restaurant entitled to the pay module. */
  private async onlineAvailable(orgId: string): Promise<boolean> {
    return !!this.checkoutPort && (await this.entitlements.isEnabled(orgId, 'pay'));
  }

  private async publicView(tx: Tx, s: SessionRow, conv: ConversationRow | null) {
    const org = await tx.one<any>(`select name, name_ar, currency, slug from organizations where id = $1`, [s.org_id]);
    const branch = s.branch_id ? await tx.maybeOne<any>(`select id, name, name_ar, address, delivery_fee_minor, min_order_minor from branches where id = $1`, [s.branch_id]) : null;
    return {
      step: s.step, version: s.version, expiresAt: new Date(s.expires_at).toISOString(), channel: s.channel,
      sandbox: conv?.transport === 'sandbox', locale: conv?.locale ?? 'en',
      org: { name: org.name, nameAr: org.name_ar, currency: org.currency, slug: org.slug },
      branch: branch ? { id: branch.id, name: branch.name, nameAr: branch.name_ar, address: branch.address, deliveryFeeMinor: Number(branch.delivery_fee_minor), minOrderMinor: Number(branch.min_order_minor) } : null,
      fulfillment: s.state.fulfillment ?? null, customerName: s.state.customerName ?? null, address: s.state.address ?? null,
      marketingConsent: s.state.marketingConsent ?? false, paymentOnlineAvailable: await this.onlineAvailable(s.org_id),
      cart: s.state.cart ?? [], quote: s.state.quote ?? null, order: s.state.order ?? null,
      paymentMethod: s.state.paymentMethod ?? null, checkoutUrl: s.step === 'awaiting_payment' ? s.state.checkout?.url ?? null : null,
    };
  }

  /** Validates and prices the cart server-side (client sends ids and quantities only). */
  async submitCart(token: string, input: OrderingCartInput) {
    const ref = await this.resolveToken(token);
    return this.db.withTenant(ref.orgId, async (tx) => {
      const { s, conv } = await this.sessionFor(tx, ref.id, true);
      this.assertLive(s, ['menu', 'review']);
      if (input.version !== s.version) throw new DomainError('stale_session', 'This order was updated elsewhere. Refresh to continue.', 409, { version: s.version });
      const lines: CartLine[] = input.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, modifiers: l.modifiers, notes: l.notes ?? null }));
      const q = await this.pricing.quote(tx, ref.orgId, { branchId: s.branch_id!, fulfillment: s.state.fulfillment!, lines, channel: s.channel, customerId: s.customer_id });
      const saved = await this.save(tx, s, { state: { ...s.state, cart: lines, quote: quoteSummary(q) }, step: 'review' }, input.version);
      if (conv && conv.status === 'bot') await this.prompt(tx, conv, saved);
      return this.publicView(tx, saved, conv);
    }, `ordering_session:${ref.id}`);
  }

  async updateDetails(token: string, input: OrderingDetailsInput) {
    const ref = await this.resolveToken(token);
    return this.db.withTenant(ref.orgId, async (tx) => {
      const { s, conv } = await this.sessionFor(tx, ref.id, true);
      this.assertLive(s, ['menu', 'review']);
      if (input.address && s.state.fulfillment !== 'delivery') throw invalid('address_not_needed', 'This order is not for delivery');
      const state: OrderingState = {
        ...s.state,
        ...(input.customerName ? { customerName: input.customerName } : {}),
        ...(input.address ? { address: { ...input.address, latitude: s.state.address?.latitude ?? null, longitude: s.state.address?.longitude ?? null } } : {}),
        ...(input.marketingConsent !== undefined ? { marketingConsent: input.marketingConsent } : {}),
      };
      const saved = await this.save(tx, s, { state }, input.version);
      return this.publicView(tx, saved, conv);
    }, `ordering_session:${ref.id}`);
  }

  async checkout(token: string, input: OrderingCheckoutInput) {
    const ref = await this.resolveToken(token);
    return this.db.withTenant(ref.orgId, async (tx) => {
      const { s, conv } = await this.sessionFor(tx, ref.id, true);
      // Safe retry: the same choice after placement returns the existing order.
      if ((s.step === 'awaiting_payment' || s.step === 'completed') && s.state.order) {
        if (s.state.paymentMethod !== input.paymentMethod) throw new DomainError('already_placed', 'This order was already placed', 409);
        return { ...(await this.publicView(tx, s, conv)), replayed: true };
      }
      this.assertLive(s, ['review']);
      if (input.version !== s.version) throw new DomainError('stale_session', 'This order was updated elsewhere. Refresh to continue.', 409, { version: s.version });
      const result = await this.placeOrder(tx, conv, s, input.paymentMethod, input.expectedTotalMinor, input.attribution, 'web');
      return { ...(await this.publicView(tx, result.session, conv)), replayed: false };
    }, `ordering_session:${ref.id}`);
  }

  async cancelByToken(token: string, version: number) {
    const ref = await this.resolveToken(token);
    return this.db.withTenant(ref.orgId, async (tx) => {
      const { s, conv } = await this.sessionFor(tx, ref.id, true);
      this.assertLive(s, ['branch', 'fulfillment', 'customer', 'address', 'menu', 'review', 'awaiting_payment']);
      if (version !== s.version) throw new DomainError('stale_session', 'This order was updated elsewhere. Refresh to continue.', 409, { version: s.version });
      await this.cancelSession(tx, guestCtx(ref.orgId, s.id, 'web'), s, 'customer');
      if (conv && conv.status === 'bot') await this.send(tx, conv, { type: 'text', body: copy(conv.locale, 'cancelled') });
      const { s: after } = await this.sessionFor(tx, ref.id);
      return this.publicView(tx, after, conv);
    }, `ordering_session:${ref.id}`);
  }

  /**
   * Places the order through the kernel (re-priced server-side) and, for online
   * payment, opens a ResutoPay checkout session. Any failure rolls back the
   * whole transaction, so no half-placed order is left behind.
   */
  private async placeOrder(tx: Tx, conv: ConversationRow | null, s: SessionRow, method: 'online' | 'cod', expectedTotalMinor: number,
    attribution: OrderAttributionInput | undefined, source: TenantContext['source']) {
    const checkout = method === 'online' ? requirePort(this.checkoutPort, 'ResutoPay checkout') : null;
    const st = s.state;
    if (!st.cart?.length || !st.branchId || !st.fulfillment) throw invalid('cart_empty', 'Choose your items first');
    if (st.fulfillment === 'delivery' && !st.address?.line1) throw invalid('address_required', 'Add a delivery address');
    const ctx = guestCtx(s.org_id, s.id, source);
    const phone = conv ? `+${conv.external_contact.replace(/^\+/, '')}` : null;
    const campaignId = await this.attributedCampaign(tx, s.org_id, s.customer_id, attribution?.campaignId);
    const utm = attribution ? Object.fromEntries(Object.entries({ utm_source: attribution.utm_source, utm_medium: attribution.utm_medium,
      utm_campaign: attribution.utm_campaign, utm_content: attribution.utm_content, utm_term: attribution.utm_term, session_key: attribution.sessionKey })
      .filter(([, v]) => v)) : {};
    const placed = await this.orders.place(tx, ctx, {
      branchId: st.branchId, channel: s.channel === 'web' ? 'web' : 'whatsapp', fulfillment: st.fulfillment, lines: st.cart,
      customer: { name: st.customerName ?? conv?.contact_name ?? null, phone, marketingConsent: !!st.marketingConsent },
      // With a phone the kernel resolves (and updates consent on) the customer itself.
      customerId: phone ? null : s.customer_id, deliveryAddress: st.fulfillment === 'delivery' ? st.address : null,
      conversationId: s.conversation_id, campaignId, attribution: { ...utm, ...(campaignId ? { campaign_id: campaignId } : {}) },
      initialStatus: method === 'online' ? 'awaiting_payment' : 'placed', expectedTotalMinor,
      notes: method === 'cod' ? (st.fulfillment === 'delivery' ? 'Cash on delivery' : 'Pay at pickup') : null,
    });
    const order = { id: placed.id, number: placed.number, publicRef: placed.publicRef, status: placed.status, totalMinor: placed.totalMinor, currency: placed.currency };
    let session: SessionRow;
    if (checkout) {
      const cs = await checkout.createSession(tx, ctx, { purpose: 'order', orderId: placed.id, channel: 'whatsapp', customerId: placed.customerId,
        returnUrl: null, description: `Order #${placed.number}` });
      session = await this.save(tx, s, { step: 'awaiting_payment', state: { ...st, paymentMethod: 'online', order, checkout: { id: cs.id, url: cs.url, expiresAt: cs.expiresAt, amountMinor: cs.amountMinor } },
        order_id: placed.id, checkout_session_id: cs.id, customer_id: placed.customerId, expiresAt: new Date(new Date(cs.expiresAt).getTime() + 10 * 60_000) });
      if (conv && conv.status === 'bot') {
        await this.send(tx, conv, { type: 'cta_url', body: copy(conv.locale, 'payLink', { number: placed.number, total: formatMoney(placed.totalMinor, placed.currency as 'EGP', conv.locale) }),
          displayText: copy(conv.locale, 'payNow'), url: cs.url });
      }
    } else {
      session = await this.save(tx, s, { step: 'completed', state: { ...st, paymentMethod: 'cod', order }, order_id: placed.id, customer_id: placed.customerId });
    }
    return { session, order, paymentMethod: method };
  }

  /** Explicit tracking-link campaign (validated) or the last campaign message this customer received in 7 days (last touch). */
  private async attributedCampaign(tx: Tx, orgId: string, customerId: string | null, explicit?: string) {
    if (explicit) {
      const c = await tx.maybeOne<{ id: string }>(`select id from campaigns where id = $1 and org_id = $2`, [explicit, orgId]);
      if (c) return c.id;
    }
    if (!customerId) return null;
    const d = await tx.maybeOne<{ campaign_id: string }>(
      `select campaign_id from campaign_deliveries where org_id = $1 and customer_id = $2 and status in ('sent', 'delivered', 'read')
          and sent_at > now() - interval '7 days' order by sent_at desc limit 1`, [orgId, customerId]);
    return d?.campaign_id ?? null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle hooks used by event handlers and jobs
  // ---------------------------------------------------------------------------
  /** order.paid (from the kernel ledger after a verified provider webhook): close the session. */
  async markPaid(tx: Tx, orderId: string) {
    const s = await tx.maybeOne<SessionRow>(`select * from ordering_sessions where order_id = $1 and step = 'awaiting_payment' for update`, [orderId]);
    if (!s) return false;
    await this.save(tx, s, { step: 'completed', state: { ...s.state, order: s.state.order ? { ...s.state.order, status: 'placed' } : s.state.order } });
    return true;
  }

  @Scheduled('connect.ordering-expiry', 60)
  async expireDue(limit = 200) {
    const rows = await this.db.withPlatform((tx) => tx.query<{ id: string; org_id: string; conversation_id: string | null }>(
      `update ordering_sessions set step = 'expired', version = version + 1
        where id in (select id from ordering_sessions where expires_at < now() and step not in ('completed', 'cancelled', 'expired') limit $1 for update skip locked)
        returning id, org_id, conversation_id`, [limit]));
    for (const r of rows) {
      if (!r.conversation_id) continue;
      await this.db.withTenant(r.org_id, async (tx) => {
        const conv = await this.messaging.conversation(tx, r.conversation_id!);
        if (conv && conv.status === 'bot') await this.send(tx, conv, { type: 'text', body: copy(conv.locale as Locale, 'expired') });
      }, 'connect.expiry');
    }
    return { expired: rows.length };
  }

  /** Staff view of the live session for the inbox. */
  async staffSummary(tx: Tx, conversationId: string) {
    const s = await tx.maybeOne<SessionRow>(`select * from ordering_sessions where conversation_id = $1 order by created_at desc limit 1`, [conversationId]);
    if (!s) return null;
    return { id: s.id, step: s.step, version: s.version, expiresAt: new Date(s.expires_at).toISOString(), fulfillment: s.state.fulfillment ?? null,
      customerName: s.state.customerName ?? null, totalMinor: s.state.quote?.totalMinor ?? null, currency: s.state.quote?.currency ?? null,
      orderId: s.order_id, orderNumber: s.state.order?.number ?? null, paymentMethod: s.state.paymentMethod ?? null };
  }
}
