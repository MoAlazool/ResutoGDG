import { Injectable } from '@nestjs/common';
import {
  ATTENTION_ACCESS, ATTENTION_KINDS, ATTENTION_RULES, type AttentionItem, type AttentionKind, type AttentionResponse, type AttentionSample,
  type AttentionSeverity,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { notFound } from '../../common/errors/domain-error';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { branchScope, iso, num } from '../analytics/scope';
import { adapterFor } from '../integrations/catalog';

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };
const R = ATTENTION_RULES;
const HREF: Record<AttentionKind, string> = {
  slow_orders: '/orders',
  unpaid_bills: '/orders',
  low_stock: '/inventory?tab=alerts',
  integrations_failing: '/integrations',
  tokens_expiring: '/integrations',
  change_approvals: '/approvals',
  creative_approvals: '/website?tab=creative',
  campaign_approvals: '/marketing',
  negative_reviews: '/analytics?tab=guests',
};

type Check = (tx: Tx, scope: string[] | null) => Promise<Omit<AttentionItem, 'kind' | 'href'> | null>;
const snippet = (s: unknown, max = 140) => (typeof s === 'string' ? (s.length > max ? `${s.slice(0, max - 1)}…` : s) : '');

/**
 * GET /o/:orgId/attention (21-HOME "Needs attention"): what needs doing now, from the restaurant's own records. Each
 * kind is read only when the caller's role has its permission (ATTENTION_ACCESS) and the plan has its module; other
 * kinds are not read and are reported in `omitted`. Everything runs in the member's RLS session; branch-scoped
 * members see their branches (plus organization-wide records such as integrations and change sets whose operations
 * stay inside their branches), and `branchId` (the shell's branch) narrows further.
 */
@Injectable()
export class AttentionService {
  constructor(private readonly db: DbService, private readonly entitlements: EntitlementsService) {}

  async attention(ctx: TenantContext, input: { branchId?: string | null }): Promise<AttentionResponse> {
    const scope = branchScope(ctx, input.branchId);
    const omitted: AttentionResponse['omitted'] = [];
    const visible: AttentionKind[] = [];
    for (const kind of ATTENTION_KINDS) {
      const { permission, module } = ATTENTION_ACCESS[kind];
      if (!ctx.can(permission)) omitted.push({ kind, reason: 'permission', permission });
      else if (module && !(await this.entitlements.isEnabled(ctx.orgId, module))) omitted.push({ kind, reason: 'module', module });
      else visible.push(kind);
    }
    const items = await this.db.scoped(ctx, async (tx) => {
      if (input.branchId && !(await tx.maybeOne('select 1 from branches where id = $1 and org_id = $2', [input.branchId, ctx.orgId]))) throw notFound('Branch');
      const out: AttentionItem[] = [];
      for (const kind of visible) {
        const r = await this.checks[kind](tx, scope);
        if (r && r.count > 0) out.push({ kind, href: HREF[kind], ...r });
      }
      return out;
    });
    items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || ATTENTION_KINDS.indexOf(a.kind) - ATTENTION_KINDS.indexOf(b.kind));
    return {
      generatedAt: new Date().toISOString(), branchId: input.branchId ?? null, items, checked: visible, omitted,
      rules: { ...R },
    };
  }

  /** One read per kind. $1 is always the organization and $2 the branch scope (null = every branch). */
  private readonly checks: Record<AttentionKind, Check> = {
    slow_orders: async (tx, scope) => {
      const where = `o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2)) and o.status in ('placed', 'accepted', 'preparing')
        and o.placed_at < now() - make_interval(mins => $3) and (o.scheduled_for is null or o.scheduled_for < now() - make_interval(mins => $3))`;
      const p = [this.org(tx), scope, R.slowOrderMinutes];
      const agg = await tx.one<{ n: number; critical: number }>(
        `select count(*)::int as n, count(*) filter (where o.placed_at < now() - make_interval(mins => $3 * 2))::int as critical from orders o where ${where}`, p);
      if (!agg.n) return null;
      const rows = await tx.query(`select o.id, o.number, o.branch_id, o.placed_at from orders o where ${where} order by o.placed_at, o.id limit ${R.samples}`, p);
      return {
        severity: agg.critical ? 'critical' : 'warning', count: agg.n, source: 'orders', provenance: 'live',
        samples: rows.map((r) => ({ id: r.id, label: String(r.number), at: iso(r.placed_at), branchId: r.branch_id })),
      };
    },
    unpaid_bills: async (tx, scope) => {
      const where = `o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2)) and o.status in ('served', 'picked_up', 'delivered')
        and o.payment_status in ('unpaid', 'partially_paid') and o.total_minor > o.paid_minor and o.placed_at > now() - make_interval(days => $3)`;
      const p = [this.org(tx), scope, R.unpaidBillDays];
      const agg = await tx.one<{ n: number }>(`select count(*)::int as n from orders o where ${where}`, p);
      if (!agg.n) return null;
      const rows = await tx.query(
        `select o.id, o.number, o.branch_id, o.placed_at, (o.total_minor - o.paid_minor)::bigint as due from orders o where ${where}
          order by o.placed_at, o.id limit ${R.samples}`, p);
      return {
        severity: 'warning', count: agg.n, source: 'orders', provenance: 'live',
        samples: rows.map((r) => ({ id: r.id, label: String(r.number), at: iso(r.placed_at), value: Number(r.due), branchId: r.branch_id })),
      };
    },
    low_stock: async (tx, scope) => {
      const from = `stock_alerts a join inventory_items i on i.id = a.item_id
        left join stock_levels sl on sl.branch_id = a.branch_id and sl.item_id = a.item_id
        where a.org_id = $1 and a.status = 'open' and ($2::uuid[] is null or a.branch_id = any($2))`;
      const p = [this.org(tx), scope];
      const agg = await tx.one<{ n: number; out: number }>(`select count(*)::int as n, count(*) filter (where coalesce(sl.quantity, 0) <= 0)::int as out from ${from}`, p);
      if (!agg.n) return null;
      const rows = await tx.query(
        `select a.id, a.branch_id, i.name, i.name_ar, coalesce(sl.quantity, 0) as quantity from ${from}
          order by coalesce(sl.quantity, 0) - a.reorder_level, a.opened_at, a.id limit ${R.samples}`, p);
      return {
        severity: agg.out ? 'critical' : 'warning', count: agg.n, source: 'stock_alerts', provenance: 'live',
        samples: rows.map((r) => ({ id: r.id, label: r.name, labelAr: r.name_ar, value: num(r.quantity), branchId: r.branch_id })),
      };
    },
    integrations_failing: async (tx, scope) => {
      const rows = await tx.query(
        `select id, provider, environment, branch_id, coalesce(last_failure_at, updated_at) as at from integration_connections
          where org_id = $1 and enabled and status = 'error' and ($2::uuid[] is null or branch_id is null or branch_id = any($2))
          order by coalesce(last_failure_at, updated_at) desc, id`, [this.org(tx), scope]);
      if (!rows.length) return null;
      const live = rows.some((r) => r.environment === 'live');
      return {
        severity: live ? 'critical' : 'warning', count: rows.length, source: 'integration_connections', provenance: live ? 'live' : 'sandbox',
        samples: rows.slice(0, R.samples).map((r) => ({ id: r.id, label: r.provider, at: iso(r.at), branchId: r.branch_id })),
      };
    },
    tokens_expiring: async (tx, scope) => {
      // Tokens the worker refreshes by itself (providers with refresh tokens) are not something to act on.
      const rows = (await tx.query(
        `select id, provider, environment, branch_id, (config->>'tokenExpiresAt')::timestamptz as expires_at from integration_connections
          where org_id = $1 and enabled and status in ('connected', 'pending') and config->>'tokenExpiresAt' is not null
            and (config->>'tokenExpiresAt')::timestamptz < now() + make_interval(days => $3)
            and ($2::uuid[] is null or branch_id is null or branch_id = any($2))
          order by (config->>'tokenExpiresAt')::timestamptz, id`, [this.org(tx), scope, R.tokenExpiryDays]))
        .filter((r) => typeof adapterFor(r.provider)?.refreshAccessToken !== 'function');
      if (!rows.length) return null;
      const soon = rows.some((r) => new Date(r.expires_at).getTime() - Date.now() < 86_400_000);
      return {
        severity: soon ? 'critical' : 'warning', count: rows.length, source: 'integration_connections',
        provenance: rows.some((r) => r.environment === 'live') ? 'live' : 'sandbox',
        samples: rows.slice(0, R.samples).map((r) => ({ id: r.id, label: r.provider, at: iso(r.expires_at), branchId: r.branch_id })),
      };
    },
    change_approvals: async (tx, scope) => {
      // As the approvals inbox: a set is visible when every operation that names a branch stays inside the scope.
      const where = `cs.org_id = $1 and cs.status = 'pending_approval' and (cs.expires_at is null or cs.expires_at > now())
        and ($2::uuid[] is null or not exists (select 1 from change_ops o where o.change_set_id = cs.id and o.branch_id is not null and not (o.branch_id = any($2::uuid[]))))`;
      const p = [this.org(tx), scope];
      const agg = await tx.one<{ n: number; soon: number }>(
        `select count(*)::int as n, count(*) filter (where cs.expires_at < now() + interval '3 hours')::int as soon from change_sets cs where ${where}`, p);
      if (!agg.n) return null;
      const rows = await tx.query(`select cs.id, cs.title, cs.created_at, cs.expires_at from change_sets cs where ${where} order by cs.expires_at nulls last, cs.id limit ${R.samples}`, p);
      return {
        severity: agg.soon ? 'warning' : 'info', count: agg.n, source: 'change_sets', provenance: 'live',
        samples: rows.map((r) => ({ id: r.id, label: r.title, at: iso(r.expires_at ?? r.created_at) })),
      };
    },
    creative_approvals: async (tx) => {
      const p = [this.org(tx)];
      const agg = await tx.one<{ n: number }>(`select count(*)::int as n from creative_assets where org_id = $1 and status = 'draft'`, p);
      if (!agg.n) return null;
      const rows = await tx.query(`select id, kind, created_at from creative_assets where org_id = $1 and status = 'draft' order by created_at, id limit ${R.samples}`, p);
      return {
        severity: 'info', count: agg.n, source: 'creative_assets', provenance: 'live',
        samples: rows.map((r) => ({ id: r.id, label: r.kind, at: iso(r.created_at) })),
      };
    },
    campaign_approvals: async (tx) => {
      const rows = await tx.query(
        `select id, name, is_sandbox, created_at from campaigns where org_id = $1 and status = 'pending_approval' order by created_at, id`, [this.org(tx)]);
      if (!rows.length) return null;
      return {
        severity: 'info', count: rows.length, source: 'campaigns', provenance: rows.every((r) => r.is_sandbox) ? 'sandbox' : 'live',
        samples: rows.slice(0, R.samples).map((r) => ({ id: r.id, label: r.name, at: iso(r.created_at) })),
      };
    },
    negative_reviews: async (tx, scope) => {
      const where = `r.org_id = $1 and ($2::uuid[] is null or r.branch_id = any($2)) and r.overall <= $3 and r.created_at > now() - make_interval(days => $4)`;
      const p = [this.org(tx), scope, R.negativeReviewMaxScore, R.negativeReviewDays];
      const agg = await tx.one<{ n: number }>(`select count(*)::int as n from guest_ratings r where ${where}`, p);
      if (!agg.n) return null;
      const rows = await tx.query(`select r.id, r.branch_id, r.overall, r.comment, r.created_at from guest_ratings r where ${where} order by r.created_at desc, r.id limit ${R.samples}`, p);
      return {
        severity: 'warning', count: agg.n, source: 'guest_ratings', provenance: 'live',
        // The comment is the guest's own words (untrusted text): the dashboard shows it isolated, never as markup.
        samples: rows.map((r): AttentionSample => ({ id: r.id, label: snippet(r.comment), value: r.overall, at: iso(r.created_at), branchId: r.branch_id })),
      };
    },
  };

  /** The tenant of the running transaction (every check is called inside db.scoped for that tenant). */
  private org(tx: Tx): string {
    return tx.ctx.orgId!;
  }
}
