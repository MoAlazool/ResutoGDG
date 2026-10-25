import { Injectable } from '@nestjs/common';
import { toWesternDigits } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService } from '../../common/db/db.service';
import { forbidden, notFound } from '../../common/errors/domain-error';
import { branchScope } from '../analytics/scope';
import { escapeLike } from '../mcp/mcp.util';

/** Most hits one search returns, across every record type (the command palette shows them in one list). */
export const SEARCH_MAX_RESULTS = 20;

export type SearchType = 'orders' | 'customers' | 'products';

export type SearchHit =
  | { type: 'order'; id: string; number: string; status: string; branchId: string; customerName: string | null; totalMinor: number; currency: string; placedAt: string }
  | { type: 'customer'; id: string; displayName: string | null; phone: string | null }
  | { type: 'product'; id: string; name: string; nameAr: string | null; priceMinor: number; currency: string };

export interface SearchResult { q: string; searched: SearchType[]; items: SearchHit[] }

/** The permission that lets a role see each record type (checked per type: a role sees only what it may read). */
const TYPE_PERMISSION = { orders: 'orders:read', customers: 'customers:read', products: 'menu:read' } as const;

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));

/**
 * Record search for the staff command palette (21-SHELL): orders by number or reference, customers by name, phone
 * or email, menu products by English or Arabic name. Every type is checked against the caller's role and runs inside
 * the member's RLS session; branch-scoped members only see their branches' orders, customers who ordered or booked
 * there, and products of menus that apply to those branches. `branchId` (the shell's branch) narrows further and must
 * be one the caller can access. Results are bounded: at most SEARCH_MAX_RESULTS hits in all.
 */
@Injectable()
export class SearchService {
  constructor(private readonly db: DbService) {}

  async search(ctx: TenantContext, input: { q: string; branchId?: string | null }): Promise<SearchResult> {
    const searched = (Object.keys(TYPE_PERMISSION) as SearchType[]).filter((t) => ctx.can(TYPE_PERMISSION[t]));
    if (!searched.length) throw forbidden(`Your role (${ctx.role}) cannot search orders, customers or the menu`);
    const scope = branchScope(ctx, input.branchId);
    const q = toWesternDigits(input.q).trim().replace(/\s+/g, ' ');
    const like = escapeLike(q);
    const digits = q.replace(/\D/g, '');
    const perType = Math.ceil(SEARCH_MAX_RESULTS / searched.length);

    const items = await this.db.scoped(ctx, async (tx) => {
      // A branch of another restaurant (or a made-up id) is not a narrower scope: it does not exist here.
      if (input.branchId && !(await tx.maybeOne('select 1 from branches where id = $1 and org_id = $2', [input.branchId, ctx.orgId]))) throw notFound('Branch');
      const out: SearchHit[] = [];
      if (searched.includes('orders')) {
        // "#17", "17" or the start of the order's reference; the newest first (numbers repeat across business days).
        const number = q.replace(/^#\s*/, '');
        const rows = await tx.query<any>(
          `select o.id, o.number, o.status, o.branch_id, o.customer_name, o.total_minor, o.currency, o.placed_at
             from orders o
            where o.org_id = $1 and ($2::uuid[] is null or o.branch_id = any($2::uuid[]))
              and (o.number = $3 or ($4::text is not null and o.public_ref like $4 || '%'))
            order by o.placed_at desc, o.id desc limit $5`,
          [ctx.orgId, scope, number, /^[0-9a-f]{6,}$/i.test(number) ? escapeLike(number.toLowerCase()) : null, perType]);
        for (const r of rows) {
          out.push({ type: 'order', id: r.id, number: r.number, status: r.status, branchId: r.branch_id, customerName: r.customer_name,
            totalMinor: Number(r.total_minor), currency: r.currency, placedAt: iso(r.placed_at) });
        }
      }
      if (searched.includes('customers')) {
        const rows = await tx.query<any>(
          `select c.id, c.display_name, c.phone_e164
             from customers c
            where c.org_id = $1 and c.merged_into_id is null and c.anonymized_at is null
              and (c.display_name ilike '%' || $3 || '%' or c.email::text ilike '%' || $3 || '%'
                   or ($4::text is not null and c.phone_e164 like '%' || $4 || '%'))
              and ($2::uuid[] is null
                   or exists (select 1 from customer_branch_stats b where b.customer_id = c.id and b.branch_id = any($2::uuid[]) and b.any_orders > 0)
                   or exists (select 1 from reservations r where r.customer_id = c.id and r.branch_id = any($2::uuid[])))
            order by c.last_seen_at desc nulls last, c.id desc limit $5`,
          [ctx.orgId, scope, like, digits.length >= 3 ? digits : null, perType]);
        for (const r of rows) out.push({ type: 'customer', id: r.id, displayName: r.display_name, phone: r.phone_e164 });
      }
      if (searched.includes('products')) {
        const rows = await tx.query<any>(
          `select p.id, p.name, p.name_ar, p.price_minor, p.currency
             from products p
             join menu_categories c on c.id = p.category_id
             join menus m on m.id = c.menu_id
            where p.org_id = $1 and p.is_active
              and ($2::uuid[] is null or m.branch_id is null or m.branch_id = any($2::uuid[]))
              and (p.name ilike '%' || $3 || '%' or p.name_ar ilike '%' || $3 || '%')
            order by p.name, p.id limit $4`,
          [ctx.orgId, scope, like, perType]);
        for (const r of rows) out.push({ type: 'product', id: r.id, name: r.name, nameAr: r.name_ar, priceMinor: Number(r.price_minor), currency: r.currency });
      }
      return out;
    });
    return { q, searched, items: items.slice(0, SEARCH_MAX_RESULTS) };
  }
}
