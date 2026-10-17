import { Inject, Injectable } from '@nestjs/common';
import { formatMoney, type Currency, type GenerateCreative } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { ENV, type Env } from '../../config/env';
import { generateCreativeCopy, type CreativeContext } from './creative-generator';
import { toCreative } from './studio.mappers';


@Injectable()
export class CreativeService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async generate(ctx: TenantContext, input: GenerateCreative) {
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
          description: input.locale === 'ar' ? p.description_ar ?? p.description : p.description,
          priceLabel: formatMoney(Number(p.price_minor), p.currency as Currency, input.locale), dietary: p.dietary ?? [],
        };
      }
      return { restaurant: { name: org.name, nameAr: org.name_ar, city: org.city }, product };
    });
    const result = await generateCreativeCopy(input, context, { apiKey: this.env.GEMINI_API_KEY, model: this.env.GEMINI_MODEL });
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.one(
        `insert into creative_assets(org_id, kind, locale, prompt, output, provider, model, is_fallback, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
        [ctx.orgId, input.kind, input.locale, input.brief, {
          variants: result.variants, tone: input.tone, productId: input.productId ?? null,
          ...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
        }, result.provider, result.model, result.isFallback, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'creative.generated', entityType: 'creative_asset', entityId: row.id, metadata: { kind: input.kind, provider: result.provider, isFallback: result.isFallback } });
      return toCreative(row);
    });
  }

  async list(ctx: TenantContext, filters: { status?: string; kind?: string; limit?: number }) {
    return this.db.scoped(ctx, async (tx) => {
      const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
      const rows = await tx.query(
        `select * from creative_assets where org_id = $1 and ($2::text is null or status = $2) and ($3::text is null or kind = $3)
          order by created_at desc limit $4`, [ctx.orgId, filters.status ?? null, filters.kind ?? null, limit]);
      return { items: rows.map(toCreative), nextCursor: null };
    });
  }

  async review(ctx: TenantContext, id: string, status: 'approved' | 'rejected' | 'used') {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne('update creative_assets set status = $2 where id = $1 and org_id = $3 returning *', [id, status, ctx.orgId]);
      if (!row) throw notFound('Creative');
      await this.audit.record(tx, ctx, { action: `creative.${status}`, entityType: 'creative_asset', entityId: id });
      return toCreative(row);
    });
  }
}
