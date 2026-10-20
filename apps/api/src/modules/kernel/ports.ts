// Cross-module ports (MODULE_CONTRACTS.md §4). The owning module implements the
// interface, marks its Nest module @Global() and provides/exports the token:
//
//   providers: [CheckoutService, { provide: CHECKOUT_PORT, useExisting: CheckoutService }],
//   exports: [CHECKOUT_PORT],
//
// Consumers inject with @Optional() @Inject(TOKEN) and call requirePort(...) so a
// missing provider is a clear 503 rather than a boot failure while modules are
// developed in parallel.
import type { TenantContext } from '../../common/auth/context';
import type { Tx } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';
import type { QuoteLoyalty } from '@resuto/contracts';
import type { PaymentMethod } from './payment-ledger.service';

export const CHECKOUT_PORT = Symbol('CHECKOUT_PORT');
export const MESSAGING_PORT = Symbol('MESSAGING_PORT');
export const SEGMENTS_PORT = Symbol('SEGMENTS_PORT');
export const CAMPAIGNS_PORT = Symbol('CAMPAIGNS_PORT');
export const ORDERS_QUERY_PORT = Symbol('ORDERS_QUERY_PORT');
// Symbol.for keeps identity stable for modules that declared these before they moved here.
export const MENU_AVAILABILITY_PORT = Symbol.for('resuto.MENU_AVAILABILITY_PORT');
export const CAMPAIGN_SEND_PORT = Symbol.for('resuto.CAMPAIGN_SEND_PORT');
export const LOYALTY_PORT = Symbol.for('resuto.LOYALTY_PORT');

export interface CheckoutSessionRequest {
  purpose: 'order' | 'visit_bill' | 'bill_share' | 'reservation_deposit' | 'payment_link';
  orderId?: string | null;
  visitId?: string | null;
  shareId?: string | null;
  reservationId?: string | null;
  /** Defaults to what is currently due for the target. */
  amountMinor?: number;
  allowedMethods?: PaymentMethod[];
  channel: 'web' | 'qr' | 'whatsapp' | 'staff' | 'mcp';
  returnUrl?: string | null;
  customerId?: string | null;
  description?: string | null;
  expiresInMinutes?: number;
}

export interface CheckoutSessionCreated {
  id: string;
  /** Bearer token for the hosted page; shown once. */
  token: string;
  /** `${APP_ORIGIN}/pay/<token>` */
  url: string;
  amountMinor: number;
  currency: string;
  expiresAt: string;
}

export interface CheckoutPort {
  createSession(tx: Tx, ctx: TenantContext, input: CheckoutSessionRequest): Promise<CheckoutSessionCreated>;
}

export interface MessagingPort {
  enqueueToCustomer(tx: Tx, ctx: TenantContext, input: {
    customerId?: string | null;
    phone?: string | null;
    templateName?: string | null;
    text?: string | null;
    variables?: Record<string, string>;
    orderId?: string | null;
    reason: string;
  }): Promise<{ messageId: string | null; skipped?: 'no_channel' | 'no_consent' | 'outside_window' }>;
}

export interface SegmentsPort {
  create(tx: Tx, ctx: TenantContext, input: { name: string; description?: string | null; definition: unknown; source: 'manual' | 'ai' | 'mcp' | 'system' }): Promise<{ id: string; memberCount: number }>;
}

export interface CampaignsPort {
  /** Drafts never send; sending requires marketing:approve through the Marketing module. */
  createDraft(tx: Tx, ctx: TenantContext, input: {
    name: string; channel: string; objective?: string; segmentId?: string | null; promotionId?: string | null;
    content: Record<string, unknown>; source: 'manual' | 'ai' | 'mcp';
  }): Promise<{ id: string; status: 'draft' }>;
}

export interface OrdersQueryPort {
  list(tx: Tx, ctx: TenantContext, filters: { branchId?: string; status?: string[]; from?: string; to?: string; limit?: number; cursor?: string }): Promise<{ items: unknown[]; nextCursor: string | null }>;
  get(tx: Tx, ctx: TenantContext, orderId: string): Promise<unknown>;
}

/** Menu (B1): per-branch product availability (the only writer of product_branch_settings.is_available). */
export interface MenuAvailabilityPort {
  setAvailability(tx: Tx, ctx: TenantContext, input: {
    productId: string; branchId: string; available: boolean; reason?: string | null; source: 'staff' | 'mcp' | 'ai';
  }): Promise<{ productId: string; branchId: string; available: boolean }>;
}

/**
 * Marketing (C): move a draft campaign to scheduled/sending under Marketing's own
 * rules (approval, consent, templates). Called only after a human approved the
 * request; the acting role must hold marketing:approve.
 */
export interface CampaignSendPort {
  requestSend(tx: Tx, ctx: TenantContext, input: {
    campaignId: string; scheduledAt?: string | null; approvedBy: string | null; source: 'mcp';
  }): Promise<{ campaignId: string; status: string; scheduledAt: string | null }>;
}

export interface LoyaltyPriceInput {
  branchId: string;
  channel?: string;
  customerId: string | null;
  /** True only when the channel has established who the customer is (staff, a visit the host linked, WhatsApp). */
  identified: boolean;
  rewardId: string | null;
  lines: Array<{ productId: string; lineTotalMinor: number }>;
  subtotalMinor: number;
  /** Discounts already applied (promotions). */
  discountMinor: number;
}

/**
 * Loyalty (FT-03): the pricing engine asks for the reward discount, the earn preview and the identified customer's
 * balance; placement commits the redemption in the order's transaction (idempotent per order).
 */
export interface LoyaltyPort {
  priceOrder(tx: Tx, orgId: string, input: LoyaltyPriceInput): Promise<QuoteLoyalty | null>;
  commitRedemption(tx: Tx, ctx: TenantContext, input: { orderId: string; customerId: string; rewardId: string; pointsCost: number; discountMinor: number }): Promise<void>;
}

export function requirePort<T>(port: T | null | undefined, name: string): T {
  if (!port) throw new DomainError('module_unavailable', `${name} is not available in this deployment`, 503);
  return port;
}
