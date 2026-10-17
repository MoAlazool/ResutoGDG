import { Injectable } from '@nestjs/common';
import type { PublicSite } from '@resuto/contracts';
import { DbService } from '../../common/db/db.service';
import { DomainError } from '../../common/errors/domain-error';
import { SiteBuilderService } from './site-builder.service';
import type { SiteDocument } from './studio.mappers';

const siteNotFound = () => new DomainError('not_found', 'Website not found', 404);
/** Ownership-verified domains route to their tenant; "active" additionally means the host confirmed TLS/routing. */
const ROUTABLE_DOMAIN_STATUSES = ['verified', 'provisioning', 'active'];

@Injectable()
export class PublicSitesService {
  constructor(private readonly db: DbService, private readonly builder: SiteBuilderService) {}

  async bySlug(slug: string): Promise<PublicSite> {
    if (!/^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/.test(slug)) throw siteNotFound();
    // Platform context only resolves the tenant id; everything else is read inside that tenant.
    const org = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string }>(
      `select id from organizations where slug = $1 and status in ('onboarding', 'active')`, [slug]));
    if (!org) throw siteNotFound();
    return this.published(org.id);
  }

  async byHost(rawHost: string): Promise<PublicSite> {
    const host = rawHost.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    if (host.length > 253 || !/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw siteNotFound();
    const row = await this.db.withPlatform((tx) => tx.maybeOne<{ org_id: string }>(
      `select d.org_id from custom_domains d join organizations o on o.id = d.org_id
        where d.hostname = $1 and d.status = any($2::text[]) and o.status in ('onboarding', 'active')`, [host, ROUTABLE_DOMAIN_STATUSES]));
    if (!row) throw siteNotFound();
    return this.published(row.org_id);
  }

  private published(orgId: string) {
    return this.db.withTenant(orgId, async (tx) => {
      const rev = await tx.maybeOne<{ revision: number; snapshot: SiteDocument; published_at: string }>(
        `select r.revision, r.snapshot, r.published_at from website_revisions r join websites w on w.id = r.website_id
          where w.org_id = $1 and w.status = 'published' order by r.revision desc limit 1`, [orgId]);
      if (!rev) throw siteNotFound();
      return this.builder.build(tx, orgId, rev.snapshot, { revision: rev.revision, publishedAt: new Date(rev.published_at).toISOString(), preview: false });
    }, 'guest:website');
  }
}
