import { Injectable } from '@nestjs/common';
import type { AssistantRequest, AssistantResult, PublicMenu, SuggestionsResult } from '@resuto/contracts';
import { DbService, type Tx } from '../../common/db/db.service';
import { notFound } from '../../common/errors/domain-error';
import { MenuService } from '../menu/menu.service';
import { VisitsService } from '../orders/visits.service';
import { candidates, planMeal, suggest, understand } from './menu-assistant';

/** How far back this branch's order history informs popularity and pairings. */
const HISTORY_DAYS = 90;

/**
 * "Help me choose" and cart suggestions over the live menu of the guest's branch (see menu-assistant.ts). Rules and
 * this branch's own order history only: no AI provider is called and nothing is metered.
 */
@Injectable()
export class GuestAssistantService {
  constructor(private readonly db: DbService, private readonly visits: VisitsService, private readonly menu: MenuService) {}

  /** Units of each product ordered at the branch recently (cancelled orders excluded). */
  private async popularity(tx: Tx, branchId: string): Promise<Map<string, number>> {
    const rows = await tx.query<{ product_id: string; n: number }>(
      `select l.product_id, sum(l.quantity)::int as n from order_lines l join orders o on o.id = l.order_id
        where o.branch_id = $1 and o.status <> 'cancelled' and o.placed_at > now() - make_interval(days => $2) and l.product_id is not null
        group by l.product_id`, [branchId, HISTORY_DAYS]);
    return new Map(rows.map((r) => [r.product_id, Number(r.n)]));
  }

  /** In how many recent orders each other product appeared next to one of the cart's products. */
  private async together(tx: Tx, branchId: string, cart: string[]): Promise<Map<string, number>> {
    if (!cart.length) return new Map();
    const rows = await tx.query<{ product_id: string; n: number }>(
      `select other.product_id, count(distinct other.order_id)::int as n
         from order_lines mine
         join order_lines other on other.order_id = mine.order_id and other.product_id is not null and not (other.product_id = any($2::uuid[]))
         join orders o on o.id = mine.order_id
        where o.branch_id = $1 and o.status <> 'cancelled' and o.placed_at > now() - make_interval(days => $3) and mine.product_id = any($2::uuid[])
        group by other.product_id order by n desc limit 20`, [branchId, cart, HISTORY_DAYS]);
    return new Map(rows.map((r) => [r.product_id, Number(r.n)]));
  }

  private async webMenu<T>(slug: string, branchCode: string | undefined, fn: (tx: Tx, menu: PublicMenu) => Promise<T>): Promise<T> {
    const org = await this.menu.resolveOrgBySlug(slug);
    return this.db.withTenant(org.id, async (tx) => {
      const branches = await tx.query<any>('select * from branches where org_id = $1 and is_active order by created_at', [org.id]);
      const branch = branchCode ? branches.find((b) => b.code === branchCode) : branches[0];
      if (!branch) throw notFound('Branch');
      return fn(tx, await this.menu.publicMenuFor(tx, org.id, branch, branches));
    }, 'guest:assistant');
  }

  private async visitMenu<T>(token: string | undefined, fn: (tx: Tx, menu: PublicMenu) => Promise<T>): Promise<T> {
    return this.visits.withGuestRead(token, async (tx, g) => {
      const branch = await tx.one('select * from branches where id = $1', [g.visit.branch_id]);
      return fn(tx, await this.menu.publicMenuFor(tx, g.ctx.orgId, branch));
    });
  }

  private async plan(tx: Tx, menu: PublicMenu, req: AssistantRequest): Promise<AssistantResult> {
    return planMeal(candidates(menu, await this.popularity(tx, menu.branch.id)), understand(req), menu.org.currency);
  }

  private async suggestions(tx: Tx, menu: PublicMenu, productIds: string[]): Promise<SuggestionsResult> {
    const cart = [...new Set(productIds)];
    const pop = await this.popularity(tx, menu.branch.id);
    return suggest(candidates(menu, pop), cart, await this.together(tx, menu.branch.id, cart));
  }

  forVisit(token: string | undefined, req: AssistantRequest) { return this.visitMenu(token, (tx, m) => this.plan(tx, m, req)); }
  forWeb(slug: string, req: AssistantRequest) { return this.webMenu(slug, req.branch, (tx, m) => this.plan(tx, m, req)); }
  suggestForVisit(token: string | undefined, productIds: string[]) { return this.visitMenu(token, (tx, m) => this.suggestions(tx, m, productIds)); }
  suggestForWeb(slug: string, branch: string | undefined, productIds: string[]) { return this.webMenu(slug, branch, (tx, m) => this.suggestions(tx, m, productIds)); }
}
