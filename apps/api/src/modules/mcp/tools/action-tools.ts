// MCP tools that change state. Writes never touch another module's tables
// directly: they go through that module's port (MODULE_CONTRACTS.md §4/§5).
// Sensitive tools only *request* an action; a human with mcp:approve approves
// it in the dashboard and the stored input is then executed exactly once.
import type { TenantContext } from '../../../common/auth/context';
import type { Tx } from '../../../common/db/db.service';
import { notFound } from '../../../common/errors/domain-error';
import { loadSendableCampaign, paymentTarget } from '../../changes/ops/effect.ops';
import { requirePort } from '../../kernel/ports';
import { OFFERED_SQL, SOLD_OUT_SQL } from '../../menu/availability';
import { maskName } from '../mcp.util';
import { defineTool, type McpTool } from './types';

const fmt = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;

async function assertSegment(tx: Tx, ctx: TenantContext, segmentId: string | undefined) {
  if (!segmentId) return null;
  const s = await tx.maybeOne<{ name: string; member_count: number }>(
    'select name, member_count from segments where org_id = $1 and id = $2', [ctx.orgId, segmentId]);
  if (!s) throw notFound('Segment');
  return s;
}

// Shared with the change-set ops that execute these requests (21-CS), so the preview and the executed op agree.
const loadCampaign = (tx: Tx, ctx: TenantContext, campaignId: string) => loadSendableCampaign(tx, ctx, campaignId);

async function productAtBranch(tx: Tx, ctx: TenantContext, productId: string, branchId: string) {
  const row = await tx.maybeOne<any>(
    `select p.name, b.name as branch_name, (${OFFERED_SQL} and not ${SOLD_OUT_SQL}) as available
       from products p join branches b on b.org_id = p.org_id and b.id = $3
       left join product_branch_settings s on s.product_id = p.id and s.branch_id = b.id
      where p.org_id = $1 and p.id = $2 and p.is_active`, [ctx.orgId, productId, branchId]);
  if (!row) throw notFound('Product');
  return row as { name: string; branch_name: string; available: boolean };
}

export const actionTools: McpTool[] = [
  defineTool('create_customer_segment', {
    description: 'Create a customer segment as a draft in Resuto Marketing (source "mcp"). Creating a segment never contacts anyone.',
    async handler(tx, ctx, input, ports) {
      const segments = requirePort(ports.segments, 'Marketing segments');
      const s = await segments.create(tx, ctx, { name: input.name, description: input.description ?? null, definition: input.definition, source: 'mcp' });
      return { segmentId: s.id, memberCount: s.memberCount, status: 'draft' as const, source: 'mcp' as const };
    },
  }),

  defineTool('prepare_campaign_draft', {
    description: 'Prepare a marketing campaign draft (source "mcp"). Drafts never send; use request_campaign_send to ask a human to approve sending.',
    async handler(tx, ctx, input, ports) {
      const campaigns = requirePort(ports.campaigns, 'Marketing campaigns');
      await assertSegment(tx, ctx, input.segmentId);
      const c = await campaigns.createDraft(tx, ctx, {
        name: input.name, channel: input.channel, objective: input.objective, segmentId: input.segmentId ?? null,
        content: { text: input.message, ...(input.messageAr ? { textAr: input.messageAr } : {}) }, source: 'mcp',
      });
      return { campaignId: c.id, status: 'draft' as const, source: 'mcp' as const,
        message: 'Draft created. Nothing was sent; a team member reviews it in Resuto Marketing.' };
    },
  }),

  defineTool('request_campaign_send', {
    description: 'SENSITIVE — asks a human to approve sending a draft campaign. Returns an approval id; nothing is sent until someone with approval rights approves it in the Resuto dashboard. Poll get_approval_status.',
    available: (ports) => !!ports.campaignSend,
    async preview(tx, ctx, input) {
      const c = await loadCampaign(tx, ctx, input.campaignId);
      const when = input.scheduledAt ? `at ${input.scheduledAt}` : 'as soon as approved';
      return {
        summary: `Send campaign "${c.name}" (${c.channel})${c.segment_name ? ` to segment "${c.segment_name}" (${c.member_count} customers)` : ''} ${when}`,
        changes: [{ label: 'Campaign status', before: c.status, after: input.scheduledAt ? 'scheduled' : 'sending' }],
        facts: [
          { label: 'Channel', value: c.channel },
          { label: 'Audience', value: c.segment_name ? `${c.segment_name} (${c.member_count})` : 'no segment' },
          { label: 'Delivery mode', value: c.is_sandbox ? 'sandbox (no real messages)' : 'live' },
        ],
      };
    },
    async handler(tx, ctx, input, ports, run) {
      const port = requirePort(ports.campaignSend, 'Campaign sending');
      await loadCampaign(tx, ctx, input.campaignId);
      return port.requestSend(tx, ctx, { campaignId: input.campaignId, scheduledAt: input.scheduledAt ?? null, approvedBy: run?.approvedBy ?? null, source: 'mcp' });
    },
  }),

  defineTool('create_payment_link', {
    description: 'SENSITIVE — asks a human to approve creating a ResutoPay payment link (for an order\'s due amount or a fixed amount in minor units). Returns an approval id; the link URL is available once from get_approval_status after approval.',
    available: (ports) => !!ports.checkout,
    async preview(tx, ctx, input) {
      const t = await paymentTarget(tx, ctx, input);
      return {
        summary: `Create a payment link for ${fmt(t.amount, t.currency)} — "${input.description}"${t.order ? ` (order #${t.order.number})` : ''}`,
        changes: [{ label: 'Payment link', before: null, after: `${fmt(t.amount, t.currency)}, valid ${input.expiresInMinutes} min` }],
        facts: [
          { label: 'Amount', value: fmt(t.amount, t.currency) },
          { label: 'Description', value: input.description },
          ...(t.order ? [{ label: 'Order', value: `#${t.order.number}` }] : []),
          ...(t.customer ? [{ label: 'Customer', value: maskName(t.customer.display_name) ?? t.customer.id }] : []),
        ],
      };
    },
    async handler(tx, ctx, input, ports) {
      const checkout = requirePort(ports.checkout, 'ResutoPay checkout');
      const t = await paymentTarget(tx, ctx, input);
      const s = await checkout.createSession(tx, ctx, {
        purpose: input.orderId ? 'order' : 'payment_link', orderId: input.orderId ?? null, amountMinor: t.amount, channel: 'mcp',
        customerId: input.customerId ?? null, description: input.description, expiresInMinutes: input.expiresInMinutes,
      });
      return { checkoutSessionId: s.id, url: s.url, amountMinor: s.amountMinor, currency: s.currency, expiresAt: s.expiresAt };
    },
  }),

  defineTool('update_product_availability', {
    description: 'SENSITIVE — asks a human to approve marking a menu product available or unavailable at one branch. Returns an approval id; nothing changes until approved.',
    available: (ports) => !!ports.menuAvailability,
    async preview(tx, ctx, input) {
      const p = await productAtBranch(tx, ctx, input.productId, input.branchId);
      const word = (v: boolean) => (v ? 'available' : 'unavailable');
      return {
        summary: `Mark "${p.name}" as ${word(input.available)} at ${p.branch_name}`,
        changes: [{ label: `Availability at ${p.branch_name}`, before: word(p.available), after: word(input.available) }],
        facts: [{ label: 'Product', value: p.name }, ...(input.reason ? [{ label: 'Reason', value: input.reason }] : [])],
      };
    },
    async handler(tx, ctx, input, ports) {
      const port = requirePort(ports.menuAvailability, 'Menu availability');
      await productAtBranch(tx, ctx, input.productId, input.branchId);
      return port.setAvailability(tx, ctx, { productId: input.productId, branchId: input.branchId, available: input.available, reason: input.reason ?? null, source: 'mcp' });
    },
  }),
];
