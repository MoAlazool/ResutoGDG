import { Inject, Injectable } from '@nestjs/common';
import { slugProblem, socialLinksOf, type MenuQr, type SlugAvailability, type SocialLinks, type SocialLinksResponse } from '@resuto/contracts';
import QRCode from 'qrcode';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { ENV, type Env } from '../../config/env';

/**
 * Free QR-menu onboarding (21-ONB, plan §6.2): the restaurant's web address check, its social links and the
 * view-only menu QR.
 *
 * The menu QR is not an ordering QR: it opens /m/<slug>, the digital menu with no cart, ordering or table session,
 * and carries no token (the address is the public slug). Ordering QRs (/t/<table token>, /v/<venue token>) are
 * issued only by the floor API.
 */
@Injectable()
export class OnboardingService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, @Inject(ENV) private readonly env: Env) {}

  /** Whether a restaurant could take `slug` as its address right now (shape, reserved words, another restaurant). */
  async slugAvailability(raw: string): Promise<SlugAvailability> {
    const slug = raw.trim().toLowerCase();
    const problem = slugProblem(slug);
    if (problem) return { slug, available: false, reason: problem };
    const taken = await this.db.withPlatform((tx) => tx.maybeOne('select 1 from organizations where slug = $1', [slug]));
    return { slug, available: !taken, reason: taken ? 'taken' : null };
  }

  socialLinks(ctx: TenantContext): Promise<SocialLinksResponse> {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.one<{ social_links: unknown }>('select social_links from organizations where id = $1', [ctx.orgId]);
      return { socialLinks: socialLinksOf(row.social_links) };
    });
  }

  /** Replaces the whole set (validated and normalized by socialLinksInput); audited as an organization update. */
  setSocialLinks(ctx: TenantContext, input: Record<string, string | undefined>): Promise<SocialLinksResponse> {
    const links: SocialLinks = socialLinksOf(Object.fromEntries(Object.entries(input).filter(([, v]) => typeof v === 'string')));
    return this.db.scoped(ctx, async (tx) => {
      const before = await tx.one<{ social_links: unknown }>('select social_links from organizations where id = $1 for update', [ctx.orgId]);
      await tx.query('update organizations set social_links = $2 where id = $1', [ctx.orgId, JSON.stringify(links)]);
      await this.audit.record(tx, ctx, {
        action: 'organization.updated', entityType: 'organization', entityId: ctx.orgId,
        metadata: { fields: ['socialLinks'], networks: Object.keys(links), previous: Object.keys(socialLinksOf(before.social_links)) },
      });
      return { socialLinks: links };
    });
  }

  /** The view-only menu QR (SVG and PNG) for the restaurant or one of its branches. */
  async menuQr(ctx: TenantContext, branchCode?: string): Promise<MenuQr> {
    const { slug, code } = await this.db.scoped(ctx, async (tx) => {
      const org = await tx.one<{ slug: string }>('select slug from organizations where id = $1', [ctx.orgId]);
      if (!branchCode) return { slug: org.slug, code: null };
      const b = await tx.maybeOne<{ id: string; code: string }>('select id, code from branches where org_id = $1 and code = $2 and is_active', [ctx.orgId, branchCode]);
      if (!b || !ctx.canAccessBranch(b.id)) throw notFound('Branch');
      return { slug: org.slug, code: b.code };
    });
    const url = `${this.env.APP_ORIGIN.replace(/\/$/, '')}/m/${encodeURIComponent(slug)}${code ? `?branch=${encodeURIComponent(code)}` : ''}`;
    const [svg, png] = await Promise.all([
      QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }),
      QRCode.toDataURL(url, { type: 'image/png', width: 1024, margin: 2, errorCorrectionLevel: 'M' }),
    ]);
    return { kind: 'menu', url, branchCode: code, svg, png };
  }
}
