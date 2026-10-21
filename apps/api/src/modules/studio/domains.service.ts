import { Inject, Injectable } from '@nestjs/common';
import type { CustomDomainView, DnsRecordInstruction } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { newToken } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { DNS_RESOLVER, DOMAIN_PROVIDER, type DomainProvider, type TxtResolver } from './domain-provider';

const MAX_DOMAINS = 5;
const RESERVED_SUFFIXES = (process.env.RESERVED_HOST_SUFFIXES ?? 'resuto.app,resuto.com,localhost,vercel.app')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

export const verificationName = (hostname: string) => `_resuto-verify.${hostname}`;

/**
 * Custom domains: ownership is proven with a TXT record that Resuto checks
 * itself; routing/TLS is delegated to the DomainProvider and a domain becomes
 * "active" only on that provider's confirmation.
 */
@Injectable()
export class DomainsService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(DNS_RESOLVER) private readonly resolveTxt: TxtResolver,
    @Inject(DOMAIN_PROVIDER) private readonly provider: DomainProvider,
  ) {}

  async list(ctx: TenantContext, q: { limit: number; cursor?: string }) {
    const k = keyset(q.cursor, { direction: 'asc' });
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(`select *, ${cursorAt('created_at')} as cursor_at from custom_domains where org_id = $1 ${k.after('created_at', 'id', 2)}
        order by created_at, id limit ${k.fetch(q.limit)}`, [ctx.orgId, ...k.params]);
      return { ...pageOf(rows, q.limit, (r) => ({ at: r.cursor_at, id: r.id }), (r) => this.view(r)),
        provider: { id: this.provider.id, readiness: this.provider.readiness } };
    });
  }

  async add(ctx: TenantContext, hostname: string) {
    if (RESERVED_SUFFIXES.some((s) => hostname === s || hostname.endsWith(`.${s}`))) {
      throw invalid('reserved_hostname', 'Use a domain you own. Resuto and hosting-provider domains cannot be added.');
    }
    const taken = await this.db.withPlatform((tx) => tx.maybeOne('select 1 from custom_domains where hostname = $1', [hostname]));
    if (taken) throw conflict('domain_taken', 'This domain is already connected to a Resuto website');
    return this.db.scoped(ctx, async (tx) => {
      const { n } = await tx.one<{ n: number }>('select count(*)::int as n from custom_domains where org_id = $1', [ctx.orgId]);
      if (n >= MAX_DOMAINS) throw invalid('too_many_domains', `A website can have at most ${MAX_DOMAINS} domains`);
      const site = await tx.one<{ id: string }>('select id from websites where org_id = $1', [ctx.orgId]);
      const row = await tx.one(
        `insert into custom_domains(org_id, website_id, hostname, verification_token, provider) values ($1, $2, $3, $4, $5) returning *`,
        [ctx.orgId, site.id, hostname, `resuto-${newToken(18)}`, this.provider.id]);
      await this.audit.record(tx, ctx, { action: 'domain.added', entityType: 'custom_domain', entityId: row.id, metadata: { hostname } });
      return this.view(row);
    });
  }

  /** Checks the ownership TXT record; on success hands the domain to the hosting provider. */
  async verify(ctx: TenantContext, domainId: string) {
    const row = await this.db.scoped(ctx, (tx) => this.get(tx, ctx, domainId));
    if (row.status === 'active') return this.view(row);
    let found = false;
    let error: string | null = null;
    if (row.status === 'pending_verification' || row.status === 'failed') {
      try {
        const records = await this.resolveTxt(verificationName(row.hostname));
        found = records.some((chunks) => chunks.join('').trim() === row.verification_token);
        if (!found) error = `The TXT record ${verificationName(row.hostname)} does not contain the verification value yet.`;
      } catch (e: any) {
        error = ['ENOTFOUND', 'ENODATA', 'NXDOMAIN'].includes(e?.code)
          ? `No TXT record found at ${verificationName(row.hostname)}. DNS changes can take up to 48 hours.`
          : `DNS lookup failed (${e?.code ?? 'error'}). Try again in a few minutes.`;
      }
      if (!found) {
        return this.db.scoped(ctx, async (tx) => {
          const updated = await tx.one(`update custom_domains set last_checked_at = now(), last_error = $2 where id = $1 returning *`, [row.id, error]);
          return this.view(updated);
        });
      }
    }
    // Ownership proven (now or earlier): attach at the hosting provider.
    let attach: Awaited<ReturnType<DomainProvider['attach']>> | null = null;
    let attachError: string | null = null;
    try {
      attach = await this.provider.attach(row.hostname);
    } catch (e) {
      attachError = (e as Error).message.slice(0, 500);
    }
    return this.db.scoped(ctx, async (tx) => {
      const updated = await tx.one(
        `update custom_domains set status = $2, verified_at = coalesce(verified_at, now()), last_checked_at = now(), last_error = $3,
                provider = $4, provider_details = $5
          where id = $1 returning *`,
        [row.id, attach ? 'provisioning' : 'verified', attachError, this.provider.id,
          attach ? { ...attach.details, routingRecords: attach.routingRecords, instructions: attach.instructions } : row.provider_details ?? {}]);
      await this.audit.record(tx, ctx, { action: 'domain.verified', entityType: 'custom_domain', entityId: row.id, metadata: { hostname: row.hostname, provider: this.provider.id, attached: !!attach } });
      return this.view(updated);
    });
  }

  /** Asks the hosting provider whether routing and TLS are live; only its confirmation makes a domain active. */
  async refresh(ctx: TenantContext, domainId: string) {
    const row = await this.db.scoped(ctx, (tx) => this.get(tx, ctx, domainId));
    if (row.status === 'pending_verification' || row.status === 'verified' || row.status === 'failed') return this.verify(ctx, domainId);
    if (row.status === 'active') return this.view(row);
    let result: Awaited<ReturnType<DomainProvider['status']>> | null = null;
    let error: string | null = null;
    try {
      result = await this.provider.status(row.hostname);
    } catch (e) {
      error = (e as Error).message.slice(0, 500);
    }
    return this.db.scoped(ctx, async (tx) => {
      const details = { ...(row.provider_details ?? {}), ...(result?.details ?? {}), statusInstructions: result?.instructions ?? [] };
      const updated = await tx.one(
        `update custom_domains set status = $2, ssl_status = $3, last_checked_at = now(), last_error = $4, provider_details = $5,
                activated_at = case when $2 = 'active' then now() else activated_at end
          where id = $1 returning *`,
        [row.id, result?.active ? 'active' : 'provisioning', result?.sslIssued ? 'issued' : 'pending', error, details]);
      if (result?.active) await this.audit.record(tx, ctx, { action: 'domain.activated', entityType: 'custom_domain', entityId: row.id, metadata: { hostname: row.hostname, provider: this.provider.id } });
      return this.view(updated);
    });
  }

  async remove(ctx: TenantContext, domainId: string) {
    const row = await this.db.scoped(ctx, (tx) => this.get(tx, ctx, domainId));
    if (['provisioning', 'active'].includes(row.status)) {
      try { await this.provider.detach(row.hostname); } catch { /* removal from Resuto must not be blocked by the provider */ }
    }
    return this.db.scoped(ctx, async (tx) => {
      await tx.query('delete from custom_domains where id = $1', [row.id]);
      await this.audit.record(tx, ctx, { action: 'domain.removed', entityType: 'custom_domain', entityId: row.id, metadata: { hostname: row.hostname } });
      return { deleted: true };
    });
  }

  private async get(tx: Tx, ctx: TenantContext, domainId: string) {
    const row = await tx.maybeOne<any>('select * from custom_domains where id = $1 and org_id = $2', [domainId, ctx.orgId]);
    if (!row) throw notFound('Domain');
    return row;
  }

  private view(r: any): CustomDomainView {
    const details = r.provider_details ?? {};
    const routingRecords: DnsRecordInstruction[] = Array.isArray(details.routingRecords) ? details.routingRecords : [];
    const verificationRecord: DnsRecordInstruction = { type: 'TXT', name: verificationName(r.hostname), value: r.verification_token, purpose: 'ownership' };
    const instructions: string[] = r.status === 'pending_verification' || r.status === 'failed'
      ? [`Add a TXT record named ${verificationRecord.name} with the value ${r.verification_token}, then press Verify.`]
      : r.status === 'active' ? [] : [...(details.instructions ?? []), ...(details.statusInstructions ?? [])];
    return {
      id: r.id,
      hostname: r.hostname,
      status: r.status,
      sslStatus: r.ssl_status,
      provider: r.provider,
      providerReadiness: r.provider === 'vercel' ? 'implemented_unverified' : 'manual',
      verificationRecord,
      routingRecords,
      instructions,
      lastCheckedAt: r.last_checked_at ? new Date(r.last_checked_at).toISOString() : null,
      verifiedAt: r.verified_at ? new Date(r.verified_at).toISOString() : null,
      lastError: r.last_error,
      createdAt: new Date(r.created_at).toISOString(),
    };
  }
}
