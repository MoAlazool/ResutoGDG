import { Inject, Injectable, Optional } from '@nestjs/common';
import {
  CREATIVE_TARGETS_BY_KIND, formatMoney, type ApplyCreative, type CreativeApplication, type CreativeView, type Currency, type GenerateCreative,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { conflict, DomainError, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { ENV, type Env } from '../../config/env';
import { PlanLimitsService } from '../billing/plan-limits.service';
import { recordUsage } from '../intelligence/ai-client.service';
import { CAMPAIGNS_PORT, type CampaignsPort } from '../kernel/ports';
import { MenuService } from '../menu/menu.service';
import { StudioAiService } from './ai/studio-ai.service';
import { generateCreativeCopy, type CreativeContext } from './creative-generator';
import { StudioService } from './studio.service';
import { toCreative } from './studio.mappers';

const LIMITS = { description: 1000, headline: 140, body: 2000, campaignText: 1024, campaignHeadline: 120 } as const;

/**
 * AI creative (Studio): generate -> review (approve/reject) -> apply. Applying is the only way copy reaches a live
 * surface, and only approved copy can be applied: a menu item's description (through the menu module), a website
 * section's draft (through the website editor; going live still needs Publish) or a campaign draft (through the
 * Marketing port; drafts never send). Each use is recorded on the creative and is idempotent per key.
 */
@Injectable()
export class CreativeService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly menu: MenuService,
    private readonly studio: StudioService,
    private readonly ai: StudioAiService,
    @Inject(ENV) private readonly env: Env,
    /**
     * FT-10: generation on Resuto's platform key counts against ai_requests_per_month; the template fallback stays
     * free, and so does the restaurant's own key (BYOK, ws9: Resuto does not pay for those model calls).
     */
    private readonly limits: PlanLimitsService,
    @Optional() @Inject(CAMPAIGNS_PORT) private readonly campaigns: CampaignsPort | null = null,
  ) {}

  async generate(ctx: TenantContext, input: GenerateCreative): Promise<CreativeView> {
    // The restaurant's own key (BYOK) wins; the operator's platform key is the fallback; otherwise templates.
    const byok = await this.ai.byok(ctx.orgId);
    const keySource = byok ? 'restaurant' : this.env.GEMINI_API_KEY ? 'resuto' : null;
    // Facts are read first (short transaction); the model call happens outside any transaction.
    const context = await this.db.scoped(ctx, async (tx): Promise<CreativeContext> => {
      const org = await tx.one<any>(
        `select o.name, o.name_ar, (select city from branches b where b.org_id = o.id and b.is_active order by created_at limit 1) as city
           from organizations o where o.id = $1`, [ctx.orgId]);
      let product: CreativeContext['product'] = null;
      if (input.productId) {
        const p = await tx.maybeOne<any>(
          'select name, name_ar, description, description_ar, price_minor, currency, dietary from products where id = $1 and org_id = $2 and is_active',
          [input.productId, ctx.orgId]);
        if (!p) throw invalid('unknown_product', 'This menu item does not exist');
        product = {
          name: p.name, nameAr: p.name_ar,
          // Same language only: an English description must not leak into Arabic copy (it could be applied to description_ar).
          description: input.locale === 'ar' ? p.description_ar ?? null : p.description,
          priceLabel: formatMoney(Number(p.price_minor), p.currency as Currency, input.locale), dietary: p.dietary ?? [],
        };
      }
      // FT-10: refuse before the platform model is called when the plan's AI requests are used up.
      if (keySource === 'resuto') await this.limits.assertAiQuota(tx, ctx.orgId);
      return { restaurant: { name: org.name, nameAr: org.name_ar, city: org.city }, product };
    });
    const result = await generateCreativeCopy(input, context, byok
      ? { apiKey: byok.apiKey, model: byok.model, fetch: byok.fetch }
      : { apiKey: this.env.GEMINI_API_KEY, model: this.env.GEMINI_MODEL });
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.one(
        `insert into creative_assets(org_id, kind, locale, prompt, output, provider, model, is_fallback, key_source, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [ctx.orgId, input.kind, input.locale, input.brief, {
          variants: result.variants, tone: input.tone, productId: input.productId ?? null,
          ...(result.fallbackReason ? { fallbackReason: result.fallbackReason, fallbackCode: result.fallbackCode } : {}),
        }, result.provider, result.model, result.isFallback, result.isFallback ? null : keySource, ctx.userId]);
      if (keySource === 'resuto' && result.provider === 'gemini' && !result.isFallback) await recordUsage(tx, ctx, { endpoint: 'studio-creative', provider: 'gemini', usage: result.usage ?? null });
      await this.audit.record(tx, ctx, { action: 'creative.generated', entityType: 'creative_asset', entityId: row.id,
        metadata: { kind: input.kind, provider: result.provider, isFallback: result.isFallback, keySource: result.isFallback ? null : keySource } });
      return toCreative(row);
    });
  }

  async list(ctx: TenantContext, filters: { status?: string; kind?: string; limit: number; cursor?: string }) {
    const k = keyset(filters.cursor);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query(
        `select *, ${cursorAt('created_at')} as cursor_at from creative_assets
          where org_id = $1 and ($2::text is null or status = $2) and ($3::text is null or kind = $3) ${k.after('created_at', 'id', 4)}
          order by created_at desc, id desc limit ${k.fetch(filters.limit)}`, [ctx.orgId, filters.status ?? null, filters.kind ?? null, ...k.params]);
      return pageOf(rows, filters.limit, (r) => ({ at: r.cursor_at, id: r.id }), toCreative);
    });
  }

  /** Approve or reject. 'used' is reached only by applying approved copy; used copy can no longer be re-reviewed. */
  async review(ctx: TenantContext, id: string, status: 'approved' | 'rejected' | 'used') {
    if (status === 'used') throw invalid('use_apply', 'Copy becomes "used" when you apply it to the menu, the website or a campaign');
    return this.db.scoped(ctx, async (tx) => {
      const cur = await tx.maybeOne<any>('select status from creative_assets where id = $1 and org_id = $2 for update', [id, ctx.orgId]);
      if (!cur) throw notFound('Creative');
      if (cur.status === 'used') throw conflict('creative_used', 'This copy is already in use and can no longer be re-reviewed', { status: cur.status });
      const row = await tx.one('update creative_assets set status = $2, reviewed_by = $3, reviewed_at = now() where id = $1 returning *', [id, status, ctx.userId]);
      await this.audit.record(tx, ctx, { action: `creative.${status}`, entityType: 'creative_asset', entityId: id });
      return toCreative(row);
    });
  }

  async apply(ctx: TenantContext, id: string, input: ApplyCreative): Promise<CreativeView> {
    const row = await this.db.scoped(ctx, (tx) => tx.maybeOne<any>('select * from creative_assets where id = $1 and org_id = $2', [id, ctx.orgId]));
    if (!row) throw notFound('Creative');
    const replay = this.replay(row, input);
    if (replay) return toCreative(row);
    if (row.status !== 'approved' && row.status !== 'used') {
      throw conflict('creative_not_approved', 'Approve this copy before using it', { status: row.status });
    }
    const allowed = CREATIVE_TARGETS_BY_KIND[row.kind] ?? [];
    if (!allowed.includes(input.target.kind)) {
      throw invalid('target_not_supported', `This kind of copy cannot be used for ${input.target.kind.replace('_', ' ')}`, { allowed });
    }
    const variant = row.output?.variants?.[input.variant] as { title?: string; text: string; hashtags?: string[] } | undefined;
    if (!variant) throw invalid('unknown_variant', 'This version does not exist');
    const locale: 'en' | 'ar' = row.locale === 'ar' ? 'ar' : 'en';
    let targetId: string;
    const t = input.target;

    if (t.kind === 'product_description') {
      ctx.require('menu:write');
      if (variant.text.length > LIMITS.description) throw invalid('copy_too_long', `A menu description can be at most ${LIMITS.description} characters`);
      const p = await this.db.scoped(ctx, (tx) => tx.maybeOne<{ version: number }>('select version from products where id = $1 and org_id = $2 and is_active', [t.productId, ctx.orgId]));
      if (!p) throw notFound('Product');
      // Through the menu module (version check, menu version bump, audit, cache invalidation); only the copy's language changes.
      await this.menu.updateProduct(ctx, t.productId, { version: p.version, ...(locale === 'ar' ? { descriptionAr: variant.text } : { description: variant.text }) });
      targetId = t.productId;
    } else if (t.kind === 'website_section') {
      ctx.require('studio:write');
      const section = await this.db.scoped(ctx, (tx) => tx.maybeOne<any>('select kind, content from website_sections where id = $1 and org_id = $2', [t.sectionId, ctx.orgId]));
      if (!section) throw notFound('Section');
      if (variant.title && variant.title.length > LIMITS.headline) throw invalid('copy_too_long', `A section headline can be at most ${LIMITS.headline} characters`);
      if (variant.text.length > LIMITS.body) throw invalid('copy_too_long', `A section text can be at most ${LIMITS.body} characters`);
      const content = { ...(section.content ?? {}) };
      if (variant.title) content.headline = { ...(content.headline ?? {}), [locale]: variant.title };
      content.body = { ...(content.body ?? {}), [locale]: variant.text };
      // The website draft changes; visitors see it after the owner publishes the website (studio:publish).
      await this.studio.updateSection(ctx, t.sectionId, { content });
      targetId = t.sectionId;
    } else {
      ctx.require('marketing:write');
      if (!this.campaigns) throw new DomainError('marketing_unavailable', 'Campaigns are not available on this server', 503);
      const text = [variant.text, variant.hashtags?.length ? variant.hashtags.join(' ') : null].filter(Boolean).join('\n\n');
      if (text.length > LIMITS.campaignText) throw invalid('copy_too_long', `A campaign message can be at most ${LIMITS.campaignText} characters`);
      const label = locale === 'ar' ? (row.kind === 'post' ? 'منشور' : 'تعليق') : (row.kind === 'post' ? 'Post' : 'Caption');
      const name = t.name ?? `${label}: ${String(row.prompt).slice(0, 80)}`;
      // Created and recorded in one transaction: a draft never exists without the creative recording it.
      return this.db.scoped(ctx, async (tx) => {
        const locked = await tx.one<any>('select * from creative_assets where id = $1 for update', [id]);
        if (this.replay(locked, input)) return toCreative(locked);
        const draft = await this.campaigns!.createDraft(tx, ctx, {
          name, channel: t.channel, content: { text, ...(variant.title ? { headline: variant.title.slice(0, LIMITS.campaignHeadline) } : {}) }, source: 'ai',
        });
        return toCreative(await this.record(tx, ctx, id, input, draft.id));
      });
    }
    return this.db.scoped(ctx, async (tx) => {
      const locked = await tx.one<any>('select * from creative_assets where id = $1 for update', [id]);
      if (this.replay(locked, input)) return toCreative(locked);
      return toCreative(await this.record(tx, ctx, id, input, targetId));
    });
  }

  /** The same key again: return the recorded result if it names the same use, refuse a different one. */
  private replay(row: any, input: ApplyCreative): boolean {
    const prior = (row.applications ?? []).find((a: CreativeApplication) => a.key === input.key);
    if (!prior) return false;
    const sameTarget = prior.target === input.target.kind && prior.variant === input.variant
      && (input.target.kind === 'campaign_draft' || prior.targetId === (input.target.kind === 'product_description' ? input.target.productId : input.target.sectionId));
    if (!sameTarget) throw conflict('idempotency_key_reused', 'This request key was already used for a different action');
    return true;
  }

  private async record(tx: any, ctx: TenantContext, id: string, input: ApplyCreative, targetId: string) {
    const application: CreativeApplication = {
      target: input.target.kind, targetId, variant: input.variant, key: input.key, appliedBy: ctx.userId ?? null, appliedAt: new Date().toISOString(),
    };
    const row = await tx.one(
      `update creative_assets set status = 'used', applications = applications || $2::jsonb where id = $1 returning *`, [id, JSON.stringify([application])]);
    await this.audit.record(tx, ctx, { action: 'creative.applied', entityType: 'creative_asset', entityId: id,
      metadata: { target: input.target.kind, targetId, variant: input.variant } });
    return row;
  }
}
