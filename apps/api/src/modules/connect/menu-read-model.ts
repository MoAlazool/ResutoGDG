import type { Tx } from '../../common/db/db.service';
import { IN_STOCK_SQL, OFFERED_SQL, SOLD_OUT_SQL } from '../menu/availability';

/**
 * Read model of the public menu for one branch, in the shape agreed in
 * MODULE_CONTRACTS.md §8 (producer B1: GET /v1/public/menu/:slug). Consumers may
 * read the catalogue tables directly; this never writes them. Prices shown here
 * are informational — orders are always re-priced by the kernel PricingService.
 */
export async function readPublicMenu(tx: Tx, orgId: string, branchId: string) {
  const org = await tx.one<any>(`select name, name_ar, currency, slug from organizations where id = $1`, [orgId]);
  const branches = await tx.query<any>(
    `select id, code, name, name_ar, accepts_dine_in, accepts_pickup, accepts_delivery, delivery_fee_minor, min_order_minor
       from branches where org_id = $1 and is_active order by created_at`, [orgId]);
  const branchView = (b: any) => ({
    id: b.id, code: b.code, name: b.name, nameAr: b.name_ar, acceptsDineIn: b.accepts_dine_in, acceptsPickup: b.accepts_pickup,
    acceptsDelivery: b.accepts_delivery, deliveryFeeMinor: Number(b.delivery_fee_minor), minOrderMinor: Number(b.min_order_minor),
  });
  const branch = branches.find((b) => b.id === branchId);
  const categories = await tx.query<any>(
    `select c.id, c.name, c.name_ar from menu_categories c join menus m on m.id = c.menu_id
      where c.org_id = $1 and c.is_active and m.is_active and (m.branch_id is null or m.branch_id = $2)
      order by m.sort_order, c.sort_order, c.created_at`, [orgId, branchId]);
  // Same rule as MenuService.publicMenuFor (SOLD_OUT_DISPLAY): products the branch does not offer are not listed;
  // `available: false` means sold out (86) or tracked stock at 0.
  const products = await tx.query<any>(
    `select p.id, p.category_id, p.name, p.name_ar, p.description, p.description_ar, coalesce(s.price_override_minor, p.price_minor) as price_minor,
            p.image_url, p.allergens, p.dietary, p.spice_level,
            (not ${SOLD_OUT_SQL} and ${IN_STOCK_SQL}) as available
       from products p left join product_branch_settings s on s.product_id = p.id and s.branch_id = $2
      where p.org_id = $1 and p.is_active and ${OFFERED_SQL} and p.category_id = any($3::uuid[])
      order by p.sort_order, p.name`, [orgId, branchId, categories.map((c) => c.id)]);
  const groups = products.length ? await tx.query<any>(
    `select pmg.product_id, g.id, g.name, g.name_ar, g.min_select, g.max_select from product_modifier_groups pmg
       join modifier_groups g on g.id = pmg.group_id where pmg.product_id = any($1::uuid[]) and g.is_active order by pmg.sort_order`,
    [products.map((p) => p.id)]) : [];
  const options = groups.length ? await tx.query<any>(
    `select id, group_id, name, name_ar, price_delta_minor, is_available from modifier_options where group_id = any($1::uuid[]) order by sort_order, name`,
    [[...new Set(groups.map((g) => g.id))]]) : [];
  return {
    org: { name: org.name, nameAr: org.name_ar, currency: org.currency, slug: org.slug },
    branch: branch ? branchView(branch) : null,
    branches: branches.map(branchView),
    categories: categories.map((c) => ({
      id: c.id, name: c.name, nameAr: c.name_ar,
      products: products.filter((p) => p.category_id === c.id).map((p) => ({
        id: p.id, name: p.name, nameAr: p.name_ar, description: p.description, descriptionAr: p.description_ar, priceMinor: Number(p.price_minor),
        imageUrl: p.image_url, allergens: p.allergens, dietary: p.dietary, spiceLevel: p.spice_level, available: p.available,
        modifierGroups: groups.filter((g) => g.product_id === p.id).map((g) => ({
          id: g.id, name: g.name, nameAr: g.name_ar, minSelect: g.min_select, maxSelect: g.max_select,
          options: options.filter((o) => o.group_id === g.id).map((o) => ({ id: o.id, name: o.name, nameAr: o.name_ar, priceDeltaMinor: Number(o.price_delta_minor), available: o.is_available })),
        })),
      })),
    })).filter((c) => c.products.length > 0),
  };
}
