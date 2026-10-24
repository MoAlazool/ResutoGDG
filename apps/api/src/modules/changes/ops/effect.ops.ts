import { CHANGE_OPS, changeOpInputs, type ChangeOpInput } from '@resuto/contracts';
import type { TenantContext } from '../../../common/auth/context';
import type { Tx } from '../../../common/db/db.service';
import { conflict, invalid, notFound } from '../../../common/errors/domain-error';
import { requirePort, type CampaignSendPort, type CheckoutPort } from '../../kernel/ports';
import { fmtMoney, isoOrNull, type OpHandler } from '../op-handler';

type CampaignSend = ChangeOpInput<'campaign.send'>;
type PaymentLink = ChangeOpInput<'payment_link.create'>;

/** A draft or approved campaign of this tenant, with its audience (shared with the MCP request_campaign_send preview). */
export async function loadSendableCampaign(tx: Tx, ctx: TenantContext, campaignId: string, lock = false) {
  const c = await tx.maybeOne<any>(
    `select c.id, c.name, c.status, c.channel, c.is_sandbox, c.segment_id, c.updated_at, s.name as segment_name, s.member_count
       from campaigns c left join segments s on s.id = c.segment_id where c.org_id = $1 and c.id = $2 ${lock ? 'for update of c' : ''}`, [ctx.orgId, campaignId]);
  if (!c) throw notFound('Campaign');
  if (!['draft', 'approved'].includes(c.status)) {
    throw conflict('campaign_not_sendable', `Campaign is ${c.status}; only draft or approved campaigns can be sent`, { status: c.status });
  }
  return c;
}

/** What a payment link would collect (shared with the MCP create_payment_link preview). */
export async function paymentTarget(tx: Tx, ctx: TenantContext, input: { orderId?: string; amountMinor?: number; customerId?: string }, lock = false) {
  const org = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]);
  let order: any = null;
  if (input.orderId) {
    order = await tx.maybeOne<any>(
      `select id, number, branch_id, total_minor, paid_minor, refunded_minor, currency, status, updated_at from orders where org_id = $1 and id = $2 ${lock ? 'for update' : ''}`,
      [ctx.orgId, input.orderId]);
    if (!order || !ctx.canAccessBranch(order.branch_id)) throw notFound('Order');
    if (order.status === 'cancelled') throw conflict('order_cancelled', 'The order is cancelled');
  }
  const due = order ? order.total_minor - (order.paid_minor - order.refunded_minor) : null;
  if (due !== null && due <= 0) throw conflict('nothing_due', 'Nothing is due on this order');
  const amount = input.amountMinor ?? due!;
  if (due !== null && amount > due) throw invalid('amount_exceeds_due', `The amount exceeds what is due (${due})`, { dueMinor: due });
  let customer: any = null;
  if (input.customerId) {
    customer = await tx.maybeOne<any>('select id, display_name from customers where org_id = $1 and id = $2', [ctx.orgId, input.customerId]);
    if (!customer) throw notFound('Customer');
  }
  return { order, due, amount, currency: (order?.currency ?? org.currency) as string, customer };
}

export function effectOps(deps: { campaignSend: () => CampaignSendPort | null; checkout: () => CheckoutPort | null }): OpHandler[] {
  const campaignSend: OpHandler<CampaignSend> = {
    type: 'campaign.send', meta: CHANGE_OPS['campaign.send'], input: changeOpInputs['campaign.send'],
    available: () => !!deps.campaignSend(),
    async validate(tx, ctx, input) {
      await loadSendableCampaign(tx, ctx, input.campaignId);
      if (input.scheduledAt && new Date(input.scheduledAt).getTime() < Date.now() - 60_000) throw invalid('schedule_in_past', 'Choose a time in the future');
    },
    async snapshot(tx, ctx, input, lock) {
      const c = await loadSendableCampaign(tx, ctx, input.campaignId, lock);
      return {
        target: { type: 'campaign', id: c.id }, version: isoOrNull(c.updated_at),
        before: { status: c.status, channel: c.channel, segmentId: c.segment_id ?? null, audience: c.member_count ?? null, sandbox: !!c.is_sandbox },
      };
    },
    async preview(tx, ctx, input) {
      const c = await loadSendableCampaign(tx, ctx, input.campaignId);
      const when = input.scheduledAt ? `at ${input.scheduledAt}` : 'as soon as approved';
      return {
        summary: `Send campaign "${c.name}" (${c.channel})${c.segment_name ? ` to segment "${c.segment_name}" (${c.member_count} customers)` : ''} ${when}`,
        changes: [{ label: 'Campaign status', before: c.status, after: input.scheduledAt ? 'scheduled' : 'sending' },
          { label: 'Delivery mode', before: null, after: c.is_sandbox ? 'sandbox (no real messages)' : 'live' }],
        after: { status: input.scheduledAt ? 'scheduled' : 'sending', scheduledAt: input.scheduledAt ?? null },
      };
    },
    // Irreversible: messages that were handed to the sender cannot be recalled (flagged for human follow-up).
    async effect(tx, ctx, input, run) {
      const port = requirePort(deps.campaignSend(), 'Campaign sending');
      const r = await port.requestSend(tx, ctx, { campaignId: input.campaignId, scheduledAt: input.scheduledAt ?? null, approvedBy: run.approvedBy, source: run.origin });
      return { result: { campaignId: r.campaignId, status: r.status, scheduledAt: r.scheduledAt } };
    },
  };

  const paymentLink: OpHandler<PaymentLink> = {
    type: 'payment_link.create', meta: CHANGE_OPS['payment_link.create'], input: changeOpInputs['payment_link.create'],
    available: () => !!deps.checkout(),
    async validate(tx, ctx, input) {
      await paymentTarget(tx, ctx, input);
    },
    async snapshot(tx, ctx, input, lock) {
      const t = await paymentTarget(tx, ctx, input, lock);
      return t.order
        ? { target: { type: 'order', id: t.order.id }, branchId: t.order.branch_id, version: isoOrNull(t.order.updated_at), before: { dueMinor: t.due, currency: t.currency } }
        : { target: null, version: null, before: null };
    },
    async preview(tx, ctx, input) {
      const t = await paymentTarget(tx, ctx, input);
      return {
        summary: `Create a payment link for ${fmtMoney(t.amount, t.currency)} — "${input.description}"${t.order ? ` (order #${t.order.number})` : ''}`,
        changes: [{ label: 'Payment link', before: null, after: `${fmtMoney(t.amount, t.currency)}, valid ${input.expiresInMinutes} min` }],
        after: { amountMinor: t.amount, currency: t.currency, expiresInMinutes: input.expiresInMinutes },
      };
    },
    async effect(tx, ctx, input, run) {
      const checkout = requirePort(deps.checkout(), 'ResutoPay checkout');
      const t = await paymentTarget(tx, ctx, input);
      const s = await checkout.createSession(tx, ctx, {
        purpose: input.orderId ? 'order' : 'payment_link', orderId: input.orderId ?? null, amountMinor: t.amount,
        channel: run.origin === 'mcp' ? 'mcp' : 'staff', customerId: input.customerId ?? null, description: input.description,
        expiresInMinutes: input.expiresInMinutes,
      });
      // The URL carries a guest bearer token: it is delivered once to the requester and never stored on the op.
      return {
        result: { checkoutSessionId: s.id, amountMinor: s.amountMinor, currency: s.currency, expiresAt: s.expiresAt, urlIssued: true },
        deliver: { checkoutSessionId: s.id, url: s.url, amountMinor: s.amountMinor, currency: s.currency, expiresAt: s.expiresAt },
      };
    },
    async reverse(tx, ctx, _input, result) {
      const checkout = requirePort(deps.checkout(), 'ResutoPay checkout');
      if (!checkout.cancelSession || typeof result.checkoutSessionId !== 'string') return false;
      return checkout.cancelSession(tx, ctx, result.checkoutSessionId, 'Change set reversed');
    },
  };

  return [campaignSend, paymentLink];
}
