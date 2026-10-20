import { Injectable } from '@nestjs/common';
import { signSimulated, type ProviderTransaction, type SimulatedEventBody, type SimulatedStore } from '@resuto/integrations';
import { randomBytes, randomUUID } from 'node:crypto';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService, type Tx } from '../../common/db/db.service';

/**
 * The simulated provider's "server side": a per-tenant sandbox webhook secret
 * and a provider-side transaction ledger (reconciliation and refunds run
 * against it exactly as against a real provider's records). No money moves.
 */
@Injectable()
export class SandboxProviderService {
  constructor(private readonly db: DbService, private readonly box: SecretBox) {}

  /** The tenant's sandbox signing secret (created on first use). Tenant context only. */
  async secret(orgId: string): Promise<string> {
    return this.db.withTenant(orgId, async (tx) => {
      const found = await tx.maybeOne<{ s: string }>('select webhook_secret_encrypted as s from payment_sandbox_accounts where org_id = $1', [orgId]);
      if (found) return this.box.open(found.s, `sandbox:${orgId}`);
      const secret = `sbx_${randomBytes(24).toString('base64url')}`;
      await tx.query(`insert into payment_sandbox_accounts(org_id, webhook_secret_encrypted) values ($1, $2) on conflict (org_id) do nothing`,
        [orgId, this.box.seal(secret, `sandbox:${orgId}`)]);
      const row = await tx.one<{ s: string }>('select webhook_secret_encrypted as s from payment_sandbox_accounts where org_id = $1', [orgId]);
      return this.box.open(row.s, `sandbox:${orgId}`);
    }, 'payments:sandbox');
  }

  store(orgId: string): SimulatedStore {
    const run = <T>(fn: (tx: Tx) => Promise<T>) => this.db.withTenant(orgId, fn, 'payments:sandbox');
    return {
      get: (providerSessionId) => run(async (tx) => {
        const r = await tx.maybeOne<any>('select * from payment_sandbox_transactions where provider_session_id = $1', [providerSessionId]);
        return r && { status: r.status, providerPaymentId: r.provider_payment_id, reference: r.reference, amountMinor: r.amount_minor, currency: r.currency, feeMinor: r.fee_minor };
      }),
      open: (input) => run(async (tx) => {
        await tx.query(`insert into payment_sandbox_transactions(org_id, provider_session_id, reference, amount_minor, currency) values ($1, $2, $3, $4, $5)`,
          [orgId, input.providerSessionId, input.reference, input.amountMinor, input.currency]);
      }),
      refund: (input) => run(async (tx) => {
        const r = await tx.maybeOne<any>('select * from payment_sandbox_transactions where provider_payment_id = $1 for update', [input.providerPaymentId]);
        if (!r) return { error: 'transaction_not_found' };
        if (r.refund_keys.includes(input.idempotencyKey)) return { providerRefundId: `sim_re_${input.idempotencyKey.slice(0, 24)}` };
        if (!['succeeded', 'partially_refunded'].includes(r.status)) return { error: `transaction_${r.status}` };
        if (r.refunded_minor + input.amountMinor > r.amount_minor) return { error: 'refund_exceeds_captured_amount' };
        const refunded = r.refunded_minor + input.amountMinor;
        await tx.query(`update payment_sandbox_transactions set refunded_minor = $2, status = $3, refund_keys = array_append(refund_keys, $4) where id = $1`,
          [r.id, refunded, refunded === r.amount_minor ? 'refunded' : 'partially_refunded', input.idempotencyKey]);
        return { providerRefundId: `sim_re_${input.idempotencyKey.slice(0, 24)}` };
      }),
      refundState: (input) => run(async (tx) => {
        const r = await tx.maybeOne<any>('select refunded_minor, refund_keys from payment_sandbox_transactions where provider_payment_id = $1', [input.providerPaymentId]);
        return r ? { applied: (r.refund_keys as string[]).includes(input.idempotencyKey), refundedMinor: Number(r.refunded_minor) } : null;
      }),
      list: (range) => run(async (tx) => {
        const rows = await tx.query<any>(
          `select * from payment_sandbox_transactions where org_id = $1 and status <> 'open' and provider_payment_id is not null
              and coalesce(completed_at, created_at) >= $2 and coalesce(completed_at, created_at) < $3 order by created_at`,
          [orgId, range.from, range.to]);
        return rows.map((r): ProviderTransaction => ({
          providerPaymentId: r.provider_payment_id, providerSessionId: r.provider_session_id, reference: r.reference, amountMinor: r.amount_minor,
          currency: r.currency, status: r.status === 'expired' ? 'failed' : r.status, feeMinor: r.fee_minor, refundedMinor: r.refunded_minor,
          createdAt: new Date(r.completed_at ?? r.created_at).toISOString(),
        }));
      }),
    };
  }

  /**
   * The tester's choice on the sandbox page: settles the provider-side record and
   * returns the signed webhook the "provider" sends. Callers deliver it through
   * the normal webhook verification path.
   */
  async settle(orgId: string, providerSessionId: string, outcome: 'success' | 'failure') {
    const updated = await this.db.withTenant(orgId, async (tx) => {
      const r = await tx.maybeOne<any>('select * from payment_sandbox_transactions where provider_session_id = $1 for update', [providerSessionId]);
      if (!r) return null;
      if (r.status !== 'open') return r;
      return tx.one<any>(
        `update payment_sandbox_transactions set status = $2, provider_payment_id = $3, completed_at = now() where id = $1 returning *`,
        [r.id, outcome === 'success' ? 'succeeded' : 'failed', `sim_pay_${randomBytes(10).toString('hex')}`]);
    }, 'payments:sandbox');
    if (!updated) return null;
    const body: SimulatedEventBody = {
      id: `evt_sim_${randomUUID()}`,
      type: updated.status === 'succeeded' || updated.status === 'refunded' || updated.status === 'partially_refunded' ? 'payment.succeeded' : 'payment.failed',
      created: Math.floor(Date.now() / 1000),
      livemode: false,
      data: {
        session_id: updated.provider_session_id, payment_id: updated.provider_payment_id, reference: updated.reference,
        amount_minor: updated.amount_minor, currency: updated.currency, fee_minor: updated.fee_minor,
        failure_reason: updated.status === 'failed' ? 'sandbox_declined_by_tester' : null,
      },
    };
    return this.signedWebhook(orgId, body);
  }

  /** Signs an event body with the tenant's sandbox secret (also used by tests to forge provider traffic). */
  async signedWebhook(orgId: string, body: SimulatedEventBody | Record<string, unknown>, timestamp = Math.floor(Date.now() / 1000)) {
    const raw = JSON.stringify(body);
    const signature = signSimulated(await this.secret(orgId), raw, timestamp);
    return { raw, headers: { 'x-resuto-sandbox-signature': signature, 'content-type': 'application/json' } };
  }
}
