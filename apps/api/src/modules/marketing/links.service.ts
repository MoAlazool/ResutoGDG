import { Injectable } from '@nestjs/common';
import type { TrackingLinkInput } from '@resuto/contracts';
import { randomBytes } from 'node:crypto';
import type { TenantContext } from '../../common/auth/context';
import { newToken } from '../../common/crypto/hash';
import { DbService } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { notFound } from '../../common/errors/domain-error';
import { cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { AuditService } from '../../common/platform/audit.service';

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const linkCode = () => [...randomBytes(9)].map((b) => ALPHABET[b % ALPHABET.length]).join('');
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

/** Builds the destination: relative path + utm_* + rcid (campaign) + rsid (click session). */
export function destinationWithParams(path: string, utm: Record<string, string | undefined>, campaignId: string | null, sessionKey: string | null) {
  const u = new URL(path, 'https://resuto.invalid');
  for (const [k, v] of Object.entries(utm)) if (v) u.searchParams.set(`utm_${k}`, v);
  if (campaignId) u.searchParams.set('rcid', campaignId);
  if (sessionKey) u.searchParams.set('rsid', sessionKey);
  return `${u.pathname}${u.search}${u.hash}`;
}

/**
 * Tracking links. GET /v1/public/l/:code counts the click, writes a link_click
 * attribution event and returns the destination; the web route /l/[code]
 * redirects to it. Ordering pages forward utm_* / rcid / rsid into the order's
 * attribution (see apps/web/app/o/[token] and MODULE docs), which the kernel
 * stores with the order (attribution_events order_placed).
 */
@Injectable()
export class TrackingLinksService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly entitlements: EntitlementsService) {}

  private view(r: any, base: string) {
    return { id: r.id, code: r.code, campaignId: r.campaign_id, destinationPath: r.destination_path, utm: r.utm, clickCount: r.click_count,
      shortUrl: `${base}/l/${r.code}`, createdAt: iso(r.created_at) };
  }

  list(ctx: TenantContext, base: string, q: { campaignId?: string; limit: number; cursor?: string }) {
    const k = keyset(q.cursor);
    return this.db.scoped(ctx, async (tx) => pageOf(await tx.query(
      `select *, ${cursorAt('created_at')} as cursor_at from tracking_links where org_id = $1 and ($2::uuid is null or campaign_id = $2)
         ${k.after('created_at', 'id', 3)} order by created_at desc, id desc limit ${k.fetch(q.limit)}`,
      [ctx.orgId, q.campaignId ?? null, ...k.params]), q.limit, (r) => ({ at: r.cursor_at, id: r.id }), (r) => this.view(r, base)));
  }

  create(ctx: TenantContext, base: string, input: TrackingLinkInput) {
    return this.db.scoped(ctx, async (tx) => {
      let utm = { ...input.utm };
      if (input.campaignId) {
        const c = await tx.maybeOne<{ utm_campaign: string; channel: string }>(`select utm_campaign, channel from campaigns where id = $1 and org_id = $2`, [input.campaignId, ctx.orgId]);
        if (!c) throw notFound('Campaign');
        utm = { source: 'resuto', medium: c.channel, campaign: c.utm_campaign, ...Object.fromEntries(Object.entries(utm).filter(([, v]) => v)) };
      }
      let row;
      for (let i = 0; i < 5 && !row; i++) {
        row = await tx.maybeOne(`insert into tracking_links(org_id, campaign_id, code, destination_path, utm) values ($1, $2, $3, $4, $5) on conflict (code) do nothing returning *`,
          [ctx.orgId, input.campaignId ?? null, linkCode(), input.destinationPath, utm]);
      }
      await this.audit.record(tx, ctx, { action: 'marketing.link_created', entityType: 'tracking_link', entityId: row.id, metadata: { campaignId: input.campaignId ?? null } });
      return this.view(row, base);
    });
  }

  /** Public click: resolves the tenant from the code (platform lookup), then records inside the tenant. */
  async click(code: string): Promise<{ destination: string; campaignId: string | null }> {
    if (!/^[A-Za-z0-9_-]{6,32}$/.test(code)) throw notFound('Link');
    const link = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string; org_id: string; campaign_id: string | null; destination_path: string; utm: Record<string, string> }>(
      `select id, org_id, campaign_id, destination_path, utm from tracking_links where code = $1`, [code]));
    if (!link) throw notFound('Link');
    // A link keeps working if the plan lapses, but clicks are only tracked while Marketing is enabled.
    if (!(await this.entitlements.isEnabled(link.org_id, 'marketing'))) {
      return { destination: destinationWithParams(link.destination_path, link.utm ?? {}, null, null), campaignId: null };
    }
    const sessionKey = newToken(12);
    await this.db.withTenant(link.org_id, async (tx) => {
      await tx.query(`update tracking_links set click_count = click_count + 1 where id = $1`, [link.id]);
      // 21-CRM: the link id goes with the click, so a customer's stored first touch can name the link.
      await tx.query(`insert into attribution_events(org_id, kind, campaign_id, session_key, utm, link_id) values ($1, 'link_click', $2, $3, $4, $5)`,
        [link.org_id, link.campaign_id, sessionKey, link.utm ?? {}, link.id]);
    }, 'tracking-link');
    return { destination: destinationWithParams(link.destination_path, link.utm ?? {}, link.campaign_id, sessionKey), campaignId: link.campaign_id };
  }
}
