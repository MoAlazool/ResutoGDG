import { Injectable } from '@nestjs/common';
import type { MarketingRecommendation, SegmentGroup } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { CampaignsService, campaignView } from './campaigns.service';
import { SegmentsService } from './segments.service';

interface Rule {
  key: string;
  title: string;
  titleAr: string;
  definition: SegmentGroup;
  channel: 'whatsapp';
  objective: 'reactivation' | 'retention' | 'upsell';
  minCount: number;
  rationale: (n: number) => string;
  draft: { en: string; ar: string };
}

/**
 * Deterministic, explainable recommendations. Each rule is a fixed segment
 * definition evaluated with the same compiler as user segments; the evidence is
 * the exact count and the rule itself. No model output, no invented numbers.
 */
const RULES: Rule[] = [
  {
    key: 'reactivation_inactive_30',
    title: 'Win back customers inactive for 30+ days', titleAr: 'استعد العملاء غير النشطين منذ 30 يومًا أو أكثر',
    definition: { op: 'and', rules: [{ type: 'consent', value: true }, { type: 'orders_gte', count: 1 }, { type: 'inactive_days_gte', days: 30 }] },
    channel: 'whatsapp', objective: 'reactivation', minCount: 1,
    rationale: (n) => `${n} customer(s) with marketing consent ordered before but not in the last 30 days.`,
    draft: { en: 'We miss you! Your favourites are waiting — order again this week.', ar: 'وحشتنا! أطباقك المفضلة في انتظارك — اطلب مرة أخرى هذا الأسبوع.' },
  },
  {
    key: 'vip_thank_you',
    title: 'Thank your regulars (3+ orders in 60 days)', titleAr: 'اشكر عملاءك الدائمين (3 طلبات أو أكثر خلال 60 يومًا)',
    definition: { op: 'and', rules: [{ type: 'consent', value: true }, { type: 'orders_gte', count: 3, withinDays: 60 }] },
    channel: 'whatsapp', objective: 'retention', minCount: 1,
    rationale: (n) => `${n} consented customer(s) placed at least 3 orders in the last 60 days.`,
    draft: { en: 'Thank you for being a regular! Here is a little something on your next visit.', ar: 'شكرًا لأنك من عملائنا الدائمين! لديك مفاجأة صغيرة في زيارتك القادمة.' },
  },
];

@Injectable()
export class RecommendationsService {
  constructor(private readonly db: DbService, private readonly segments: SegmentsService, private readonly campaigns: CampaignsService, private readonly audit: AuditService) {}

  list(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const items: MarketingRecommendation[] = [];
      for (const r of RULES) {
        const { n } = await this.segments.count(tx, ctx.orgId, r.definition);
        if (n < r.minCount) continue;
        items.push({ key: r.key, title: r.title, titleAr: r.titleAr, rationale: r.rationale(n), evidence: { matchingCustomers: n, rule: r.definition, method: 'deterministic_rule' },
          action: { kind: 'create_campaign_draft', channel: r.channel, objective: r.objective, segmentDefinition: r.definition } });
      }
      // Consent gap: recent customers we cannot message. Advice only — no draft.
      const gap = await tx.one<{ recent: number; without: number }>(
        `select count(distinct c.id)::int as recent, count(distinct c.id) filter (where not c.marketing_consent)::int as without
           from customers c join orders o on o.customer_id = c.id where c.org_id = $1 and o.placed_at > now() - interval '30 days' and o.status <> 'cancelled'`, [ctx.orgId]);
      if (gap.recent >= 5 && gap.without * 2 > gap.recent) {
        items.push({ key: 'consent_gap', title: 'Ask more customers for marketing consent', titleAr: 'اطلب موافقة تسويقية من عملاء أكثر',
          rationale: `${gap.without} of ${gap.recent} customers who ordered in the last 30 days have not opted in to marketing messages.`,
          evidence: { recentCustomers: gap.recent, withoutConsent: gap.without, method: 'deterministic_rule' }, action: { kind: 'none' } });
      }
      return { items, method: 'Rule-based recommendations computed from your own data; counts are exact at the time of the request.' };
    });
  }

  /** One click: creates the segment and a DRAFT campaign (still needs approval to send). */
  apply(ctx: TenantContext, key: string) {
    const rule = RULES.find((r) => r.key === key);
    if (!rule) throw notFound('Recommendation');
    return this.db.scoped(ctx, async (tx) => {
      const stamp = new Date().toISOString().slice(0, 10);
      const existing = await tx.query<{ name: string }>(`select name from segments where org_id = $1 and name like $2`, [ctx.orgId, `${rule.title} · ${stamp}%`]);
      const name = existing.length ? `${rule.title} · ${stamp} (${existing.length + 1})` : `${rule.title} · ${stamp}`;
      const seg = await this.segments.create(tx, ctx, { name, description: `Created from the "${rule.key}" recommendation`, definition: rule.definition, source: 'system' });
      const locale = (await tx.one<{ default_locale: string }>(`select default_locale from organizations where id = $1`, [ctx.orgId])).default_locale === 'ar' ? 'ar' : 'en';
      const draft = await this.campaigns.createDraft(tx, ctx, { name, channel: rule.channel, objective: rule.objective, segmentId: seg.id, source: 'ai',
        content: { text: rule.draft[locale], recommendation: { key: rule.key, generatedBy: 'deterministic_rules', memberCount: seg.memberCount } } });
      await this.audit.record(tx, ctx, { action: 'marketing.recommendation_applied', entityType: 'campaign', entityId: draft.id, metadata: { key } });
      return { segmentId: seg.id, memberCount: seg.memberCount, campaign: campaignView(await tx.one(`select * from campaigns where id = $1`, [draft.id])) };
    });
  }
}
