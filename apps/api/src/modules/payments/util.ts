import { TenantContext } from '../../common/auth/context';
import { DomainError } from '../../common/errors/domain-error';

/** Tenant context for a guest acting through a bearer link (checkout, visit, share, reservation token). */
export const guestCtx = (orgId: string, actorId: string) => new TenantContext(orgId, 'admin', null, null, 'guest', actorId.slice(0, 120), 'web');
/** Tenant context for provider webhooks (verified signatures only). */
export const webhookCtx = (orgId: string, provider: string) => TenantContext.system(orgId, `webhook:${provider}`, 'webhook');

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

export const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

export const gone = (code: string, message: string) => new DomainError(code, message, 410);

/** Public-facing payment row (camelCase). */
export function toPayment(p: any) {
  return {
    id: p.id, branchId: p.branch_id, orderId: p.order_id, visitId: p.visit_id, reservationId: p.reservation_id, shareId: p.share_id,
    checkoutSessionId: p.checkout_session_id, method: p.method, provider: p.provider, providerPaymentId: p.provider_payment_id,
    amountMinor: p.amount_minor, currency: p.currency, feeMinor: p.fee_minor, netMinor: p.net_minor, status: p.status,
    refundedMinor: p.refunded_minor, isTest: p.is_test, receivedBy: p.received_by, driverId: p.driver_id, failureReason: p.failure_reason,
    reference: p.raw?.reference ?? null, capturedAt: iso(p.captured_at), createdAt: iso(p.created_at),
  };
}

export function toRefund(r: any) {
  return {
    id: r.id, paymentId: r.payment_id, amountMinor: r.amount_minor, reason: r.reason, status: r.status, provider: r.provider,
    providerRefundId: r.provider_refund_id, instructions: r.instructions, failureReason: r.failure_reason,
    createdBy: r.created_by, createdAt: iso(r.created_at), completedAt: iso(r.completed_at),
  };
}

export const SETTLED = ['succeeded', 'partially_refunded', 'refunded'];
