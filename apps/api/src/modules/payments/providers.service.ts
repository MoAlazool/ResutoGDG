import { Inject, Injectable } from '@nestjs/common';
import type { CheckoutMethodOption, PaymentMethodKey } from '@resuto/contracts';
import { paymentAdapter, PAYMENT_ADAPTERS, type AdapterContext, type PaymentAdapter } from '@resuto/integrations';
import { ENV, type Env } from '../../config/env';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService, type Tx } from '../../common/db/db.service';
import { SandboxProviderService } from './sandbox.service';

export interface ResolvedProvider {
  provider: string;
  adapter: PaymentAdapter;
  connectionId: string | null;
  environment: 'sandbox' | 'live';
  sandbox: boolean;
  config: Record<string, unknown>;
}

interface ConnectionRow { id: string; provider: string; branch_id: string | null; environment: 'sandbox' | 'live'; status: string; config: any }

/** Provider preference per country when several are connected. */
const PREFERENCE: Record<string, string[]> = { EG: ['paymob', 'stripe', 'moyasar'], SA: ['moyasar', 'paymob', 'stripe'] };
/** Manual (no-adapter) methods configured as payments connections with instructions in config. */
const MANUAL_PROVIDERS: Record<string, PaymentMethodKey> = { instapay: 'instapay', bank_transfer: 'bank_transfer' };

/**
 * Which providers and methods a branch can take, honouring PAYMENT_MODE:
 * sandbox → only the simulated provider and sandbox-environment connections;
 * live → only live connections (the simulated provider is disabled).
 * Credentials are read in tenant context (member sessions cannot select them).
 */
@Injectable()
export class PaymentProvidersService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly box: SecretBox,
    private readonly sandbox: SandboxProviderService,
  ) {}

  get mode() {
    return this.env.PAYMENT_MODE;
  }

  private async connections(tx: Tx, orgId: string, branchId: string | null): Promise<ConnectionRow[]> {
    const env = this.mode === 'sandbox' ? 'sandbox' : 'live';
    return tx.query<ConnectionRow>(
      `select id, provider, branch_id, environment, status, config from integration_connections
        where org_id = $1 and category = 'payments' and environment = $2 and status in ('connected', 'sandbox')
          and (branch_id is null or branch_id = $3)
        order by (branch_id is not null) desc, created_at`, [orgId, env, branchId]);
  }

  private async country(tx: Tx, orgId: string) {
    return (await tx.one<{ country: string }>('select country from organizations where id = $1', [orgId])).country;
  }

  /** Online providers usable for a method, best first. */
  async resolve(tx: Tx, orgId: string, branchId: string | null, method: 'card' | 'wallet'): Promise<ResolvedProvider | null> {
    const conns = await this.connections(tx, orgId, branchId);
    const order = PREFERENCE[await this.country(tx, orgId)] ?? [];
    const candidates = conns
      .filter((c) => c.provider !== 'simulated' && PAYMENT_ADAPTERS[c.provider]?.methods.includes(method))
      .filter((c) => c.provider !== 'paymob' || !!(method === 'wallet' ? c.config?.integrationIdWallet : c.config?.integrationIdCard))
      .sort((a, b) => (order.indexOf(a.provider) + 99 * Number(order.indexOf(a.provider) < 0)) - (order.indexOf(b.provider) + 99 * Number(order.indexOf(b.provider) < 0)));
    const c = candidates[0];
    if (c) {
      return { provider: c.provider, adapter: paymentAdapter(c.provider)!, connectionId: c.id, environment: c.environment, sandbox: c.environment === 'sandbox', config: c.config ?? {} };
    }
    if (this.mode === 'sandbox') {
      return { provider: 'simulated', adapter: paymentAdapter('simulated')!, connectionId: null, environment: 'sandbox', sandbox: true, config: {} };
    }
    return null;
  }

  /** Methods a branch can offer for a purpose (online via providers, offline via staff confirmation). */
  async methodsFor(tx: Tx, orgId: string, branchId: string, opts: { purpose: string; fulfillment?: string | null }): Promise<CheckoutMethodOption[]> {
    const out: CheckoutMethodOption[] = [];
    for (const m of ['card', 'wallet'] as const) {
      const r = await this.resolve(tx, orgId, branchId, m);
      if (r) out.push({ method: m, kind: 'online', provider: r.provider, sandbox: r.sandbox });
    }
    if (opts.purpose === 'reservation_deposit') return out; // deposits are collected online only
    if (opts.fulfillment === 'delivery') {
      out.push({ method: 'cod', kind: 'offline', provider: null, sandbox: false, instructions: 'Pay the driver when your order arrives.' });
    } else {
      out.push({ method: 'cash', kind: 'offline', provider: null, sandbox: false, instructions: 'Pay at the counter or to your waiter; staff will confirm it.' });
    }
    for (const c of await this.connections(tx, orgId, branchId)) {
      const method = MANUAL_PROVIDERS[c.provider];
      if (!method || out.some((o) => o.method === method)) continue;
      const details = method === 'instapay'
        ? `Send the amount by InstaPay to ${String(c.config?.address ?? '').slice(0, 80)} and show the confirmation to staff.`
        : `Transfer the amount to ${String(c.config?.accountName ?? '')} ${String(c.config?.iban ?? '')} (${String(c.config?.bankName ?? '')}) and show the receipt to staff.`;
      out.push({ method, kind: 'offline', provider: null, sandbox: false, instructions: details.replace(/\s+/g, ' ').trim() });
    }
    return out;
  }

  /** Adapter context with decrypted credentials (own tenant transaction; never in member context). */
  async adapterContext(orgId: string, resolved: { provider: string; connectionId: string | null }, extra: Record<string, unknown> = {}): Promise<AdapterContext> {
    if (resolved.provider === 'simulated') {
      if (this.mode !== 'sandbox') throw new Error('Simulated payments are disabled in live mode');
      return { environment: 'sandbox', credentials: { webhookSecret: await this.sandbox.secret(orgId) }, config: { store: this.sandbox.store(orgId), ...extra }, fetch };
    }
    const creds = await this.credentials(orgId, resolved.connectionId);
    if (!creds) throw new Error(`No usable ${resolved.provider} connection`);
    return { environment: creds.environment, credentials: creds.credentials, config: { ...creds.config, ...extra }, fetch };
  }

  async credentials(orgId: string, connectionId: string | null): Promise<null | { provider: string; environment: 'sandbox' | 'live'; credentials: Record<string, string>; config: Record<string, unknown> }> {
    if (!connectionId) return null;
    return this.db.withTenant(orgId, async (tx) => {
      const c = await tx.maybeOne<any>(
        `select provider, category, environment, status, credentials_encrypted, config from integration_connections where id = $1 and category in ('payments', 'accounting')`, [connectionId]);
      if (!c || !c.credentials_encrypted || !['connected', 'sandbox'].includes(c.status)) return null;
      if (c.category === 'payments' && (this.mode === 'sandbox') !== (c.environment === 'sandbox')) return null;
      try {
        return { provider: c.provider, environment: c.environment, credentials: this.box.openJson<Record<string, string>>(c.credentials_encrypted), config: c.config ?? {} };
      } catch {
        return null;
      }
    }, 'payments:credentials');
  }
}
