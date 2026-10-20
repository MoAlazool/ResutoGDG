import { Inject, Injectable, Logger } from '@nestjs/common';
import type { CheckoutMethodOption, PaymentMethodKey } from '@resuto/contracts';
import { paymentAdapter, type AdapterContext, type PaymentAdapter } from '@resuto/integrations';
import { ENV, type Env } from '../../config/env';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService, type Tx } from '../../common/db/db.service';
import { credentialsAad } from '../integrations/connections.service';
import { ProviderHttp } from '../integrations/provider-http';
import { SandboxProviderService } from './sandbox.service';

export interface ResolvedProvider {
  provider: string;
  adapter: PaymentAdapter;
  connectionId: string | null;
  environment: 'sandbox' | 'live';
  sandbox: boolean;
  config: Record<string, unknown>;
}

export interface ConnectionCredentials {
  connectionId: string;
  provider: string;
  category: string;
  environment: 'sandbox' | 'live';
  status: string;
  enabled: boolean;
  credentials: Record<string, string>;
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
 * New checkouts use only ENABLED, healthy connections (INT-07); webhooks,
 * status checks and refunds for existing payments still resolve their own
 * connection while it is disabled, so money already in flight is accounted for.
 * Credentials are read in tenant context (member sessions cannot select them).
 */
@Injectable()
export class PaymentProvidersService {
  private readonly logger = new Logger('PaymentProviders');

  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly box: SecretBox,
    private readonly sandbox: SandboxProviderService,
    private readonly http: ProviderHttp,
  ) {}

  get mode() {
    return this.env.PAYMENT_MODE;
  }

  /** Outbound HTTP for payment adapters (the integrations module's single entry point; tests script it). */
  get fetch(): typeof fetch {
    return (input, init) => this.http.fetch(input, init);
  }

  private async connections(tx: Tx, orgId: string, branchId: string | null): Promise<ConnectionRow[]> {
    const env = this.mode === 'sandbox' ? 'sandbox' : 'live';
    return tx.query<ConnectionRow>(
      `select id, provider, branch_id, environment, status, config from integration_connections
        where org_id = $1 and category = 'payments' and environment = $2 and status in ('connected', 'sandbox') and enabled
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
    const rank = (p: string) => (order.indexOf(p) < 0 ? 99 : order.indexOf(p));
    const candidates = conns
      .filter((c) => c.provider !== 'simulated' && !!paymentAdapter(c.provider)?.methods.includes(method))
      .filter((c) => c.provider !== 'paymob' || !!(method === 'wallet' ? c.config?.integrationIdWallet : c.config?.integrationIdCard))
      .sort((a, b) => rank(a.provider) - rank(b.provider));
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

  /**
   * Adapter context with decrypted credentials (own tenant transaction; never in member context).
   * The context carries the CONNECTION's environment, so key-prefix and event checks bind to it.
   */
  async adapterContext(orgId: string, resolved: { provider: string; connectionId: string | null }, extra: Record<string, unknown> = {}): Promise<AdapterContext> {
    if (resolved.provider === 'simulated') {
      if (this.mode !== 'sandbox') throw new Error('Simulated payments are disabled in live mode');
      return { environment: 'sandbox', credentials: { webhookSecret: await this.sandbox.secret(orgId) }, config: { store: this.sandbox.store(orgId), ...extra }, fetch: this.fetch };
    }
    const creds = await this.credentials(orgId, resolved.connectionId);
    if (!creds || creds.provider !== resolved.provider) throw new Error(`No usable ${resolved.provider} connection`);
    return { environment: creds.environment, credentials: creds.credentials, config: { ...creds.config, ...extra }, fetch: this.fetch };
  }

  /**
   * Decrypts a payments/accounting connection. Credentials are sealed by the
   * Integrations module with AAD "<orgId>:<provider>" (INT-04). Rows written by
   * an older fixture path without AAD are still readable once and are re-sealed
   * with the AAD in the same call, so they migrate on first use.
   */
  async credentials(orgId: string, connectionId: string | null): Promise<null | ConnectionCredentials> {
    if (!connectionId) return null;
    return this.db.withTenant(orgId, async (tx) => {
      const c = await tx.maybeOne<any>(
        `select id, org_id, provider, category, environment, status, enabled, credentials_encrypted, config from integration_connections
          where id = $1 and org_id = $2 and category in ('payments', 'accounting')`, [connectionId, orgId]);
      if (!c || !c.credentials_encrypted || !['connected', 'sandbox'].includes(c.status)) return null;
      if (c.category === 'payments' && (this.mode === 'sandbox') !== (c.environment === 'sandbox')) return null;
      // INT-07: a disabled accounting connection pushes nothing. Disabled PAYMENT connections still verify webhooks,
      // answer status queries and refund their existing payments (new checkouts never use them — see connections()).
      if (c.category === 'accounting' && !c.enabled) return null;
      const credentials = await this.open(tx, c);
      if (!credentials) return null;
      return { connectionId: c.id, provider: c.provider, category: c.category, environment: c.environment, status: c.status, enabled: c.enabled, credentials, config: c.config ?? {} };
    }, 'payments:credentials');
  }

  private async open(tx: Tx, c: { id: string; org_id: string; provider: string; credentials_encrypted: string }): Promise<Record<string, string> | null> {
    const aad = credentialsAad(c.org_id, c.provider);
    try {
      return this.box.openJson<Record<string, string>>(c.credentials_encrypted, aad);
    } catch {
      try {
        const legacy = this.box.openJson<Record<string, string>>(c.credentials_encrypted);
        await tx.query(`update integration_connections set credentials_encrypted = $2 where id = $1`, [c.id, this.box.sealJson(legacy, aad)]);
        this.logger.warn(`re-sealed legacy credentials of connection ${c.id} with the tenant AAD`);
        return legacy;
      } catch {
        this.logger.warn(`credentials of connection ${c.id} cannot be decrypted`);
        return null;
      }
    }
  }

  /** Records provider-side success/failure and the latest verified webhook on the connection (INT-17). */
  async touch(orgId: string, connectionId: string | null, what: 'success' | 'failure' | 'webhook', extra: { accountName?: string | null } = {}) {
    if (!connectionId) return;
    const column = what === 'success' ? 'last_success_at' : what === 'failure' ? 'last_failure_at' : 'last_webhook_at';
    await this.db.withTenant(orgId, (tx) => tx.query(
      `update integration_connections set ${column} = now(),
          account_identity = case when $2::text is not null then account_identity || jsonb_build_object('webhookAccountName', $2::text) else account_identity end
        where id = $1`, [connectionId, extra.accountName ?? null]), 'payments:diagnostics').catch((e) => this.logger.warn(`touch ${connectionId}: ${(e as Error).message}`));
  }
}
