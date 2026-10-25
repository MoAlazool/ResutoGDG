import { Injectable } from '@nestjs/common';
import type {
  Category, MenuEditorView, MenuImportPreview, MenuImportRequest, ModifierGroup, Product, ProductInput, ProductUpdate, PublicBranch, PublicMenu,
} from '@resuto/contracts';
import { socialLinksOf } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound, badRequest } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { createHash } from 'node:crypto';
import { BoundedCache } from '../../common/cache/bounded-cache';
import { MediaUrls, StorageService, stableExpiry } from '../../common/storage/storage.service';
import { csvToRows, previewRows } from './menu-import';
import { IN_STOCK_SQL, OFFERED_SQL, SOLD_OUT_SQL } from './availability';
import { Scheduled } from '../../common/events/events';

/** Cross-module port for ResutoMCP; the lead's kernel/ports.ts declares the same Symbol.for token. */
export const MENU_AVAILABILITY_PORT = Symbol.for('resuto.MENU_AVAILABILITY_PORT');
/** `available: false` is the temporary 86 (sold out), never "not offered at this branch" (FT-02 / DF-01). */
export interface MenuAvailabilityInput {
  productId: string; branchId: string; available: boolean; reason?: string | null; source: 'staff' | 'mcp' | 'ai';
  /** Automatic restore: 'end_of_day' (the branch's next local midnight) or an ISO time; null/undefined = until cleared. */
  until?: string | null;
}

const PRODUCT_COLUMNS: Record<string, string> = {
  categoryId: 'category_id', name: 'name', nameAr: 'name_ar', description: 'description', descriptionAr: 'description_ar',
  priceMinor: 'price_minor', costMinor: 'cost_minor', station: 'station', prepMinutes: 'prep_minutes', spiceLevel: 'spice_level',
  dietary: 'dietary', allergens: 'allergens', ingredients: 'ingredients', calories: 'calories', imageUrl: 'image_url',
  isActive: 'is_active', trackStock: 'track_stock', sortOrder: 'sort_order', externalRef: 'external_ref',
};

/** The price after a percent discount (basis points), rounded to the nearest minor unit and never below 1. */
export const discountedPrice = (originalMinor: number, discountBps: number) => Math.max(1, Math.round((originalMinor * (10000 - discountBps)) / 10000));

export const toCategory = (r: any): Category => ({
  id: r.id, menuId: r.menu_id, name: r.name, nameAr: r.name_ar, description: r.description, defaultStation: r.default_station,
  sortOrder: r.sort_order, isActive: r.is_active,
});

/** Signed menu image URLs: stable for a UTC day (PCL-14), so browsers and CDNs reuse the download. */
export const MENU_IMAGE_TTL_SECONDS = 24 * 3600;
/** Width the guest menu card needs (a 2x phone card); detail views use the srcset. */
const MENU_IMAGE_MIN_WIDTH = 640;
/**
 * Public menu HTTP caching (PCL-15, docs/CACHE_POLICY.md): guests and CDNs may reuse a menu for 15 s (30 s at a
 * shared cache), serve it stale while revalidating for a minute and during an outage for 10 minutes. Revalidation is
 * cheap: the ETag is derived from menu_versions (bumped by triggers on every menu change) and the image URL window.
 */
export const PUBLIC_MENU_CACHE_CONTROL = 'public, max-age=15, s-maxage=30, stale-while-revalidate=60, stale-if-error=600';
/** For a public menu built while some image URLs could not be signed: nobody may keep it, so the next request rebuilds it. */
export const PUBLIC_MENU_NO_STORE = 'no-store';
/** Bump when the public menu response shape changes, so cached copies from an older build are not revalidated. */
const PUBLIC_MENU_SHAPE = 4;   // 4: org.socialLinks (21-ONB)

/** Branch columns the public menu exposes (toPublicBranch) plus the lookup code (PCL-28: no select *). */
export const PUBLIC_BRANCH_COLUMNS = `id, code, name, name_ar, accepts_dine_in, accepts_pickup, accepts_delivery, accepts_reservations, delivery_fee_minor,
  min_order_minor, address, city, phone`;

export const toPublicBranch = (b: any): PublicBranch => ({
  id: b.id, code: b.code, name: b.name, nameAr: b.name_ar, acceptsDineIn: b.accepts_dine_in, acceptsPickup: b.accepts_pickup,
  acceptsDelivery: b.accepts_delivery, acceptsReservations: b.accepts_reservations, deliveryFeeMinor: b.delivery_fee_minor,
  minOrderMinor: b.min_order_minor, address: b.address, city: b.city, phone: b.phone,
});

/**
 * Catalog: categories, products (bilingual, allergens, stations, per-branch
 * availability/price/stock), modifier groups, imports and the public menu.
 * Every staff mutation is audited and publishes `menu.updated`.
 */
@Injectable()
export class MenuService {
  /** Built public menus by (org, branch, menu version, URL window): bounded and short-lived (PCL-25). */
  private readonly builtMenus = new BoundedCache<PublicMenu>(1000, 60_000);

  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly idempotency: IdempotencyService,
    private readonly storage: StorageService,
  ) {}

  // ---------------------------------------------------------------------------
  // Editor view
  // ---------------------------------------------------------------------------
  async editorView(ctx: TenantContext): Promise<MenuEditorView> {
    const urls = this.storage.urls(MENU_IMAGE_TTL_SECONDS);
    const view = await this.db.scoped(ctx, async (tx) => {
      const org = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]);
      const menus = await tx.query('select id, name, name_ar, branch_id, is_active from menus where org_id = $1 order by sort_order, created_at', [ctx.orgId]);
      const categories = await tx.query('select * from menu_categories where org_id = $1 order by sort_order, created_at', [ctx.orgId]);
      const products = await this.loadProducts(tx, ctx, null, urls);
      const modifierGroups = await this.loadGroups(tx, ctx.orgId, null, false);
      const stations = await tx.query<{ station: string }>(
        `select distinct station from (select station from products where org_id = $1 and is_active
           union select default_station from menu_categories where org_id = $1 and default_station is not null) s order by station`, [ctx.orgId]);
      return {
        menus: menus.map((m) => ({ id: m.id, name: m.name, nameAr: m.name_ar, branchId: m.branch_id, isActive: m.is_active })),
        categories: categories.map(toCategory), products, modifierGroups,
        stations: stations.map((s) => s.station).filter(Boolean), currency: org.currency,
      };
    });
    // Image URLs are signed in one batch after the transaction has committed (PCL-11, PS-18).
    await urls.resolve();
    return view;
  }

  async getProduct(ctx: TenantContext, productId: string): Promise<Product> {
    const urls = this.storage.urls(MENU_IMAGE_TTL_SECONDS);
    const product = await this.db.scoped(ctx, async (tx) => {
      const [p] = await this.loadProducts(tx, ctx, [productId], urls);
      if (!p) throw notFound('Product');
      return p;
    });
    await urls.resolve();
    return product;
  }

  /**
   * Products with their image URLs. The URLs are filled when the caller resolves `urls` after its transaction (PCL-11:
   * a helper that receives a transaction never calls storage).
   */
  private async loadProducts(tx: Tx, ctx: TenantContext, ids: string[] | null, urls: MediaUrls): Promise<Product[]> {
    const orgId = ctx.orgId;
    const own = urls;
    const rows = await tx.query<any>(
      `select p.*, m.path as media_path from products p left join media_assets m on m.id = p.image_media_id
        where p.org_id = $1 and ($2::uuid[] is null or p.id = any($2::uuid[])) order by p.sort_order, p.created_at`, [orgId, ids]);
    if (!rows.length) return [];
    const productIds = rows.map((r) => r.id);
    const settings = await tx.query<any>(
      `select s.*, ${SOLD_OUT_SQL} as sold_out_now from product_branch_settings s where s.product_id = any($1::uuid[])`, [productIds]);
    const groups = await tx.query<any>('select product_id, group_id from product_modifier_groups where product_id = any($1::uuid[]) order by sort_order', [productIds]);
    // Ingredient-tracked portions (legacy "Portions" column, PAR-03): per branch, the scarcest recipe ingredient decides
    // (stock on hand / quantity per portion, rounded down, never below zero). Stock levels follow branch scope (RLS).
    // They are derived from stock levels, so only a caller who may read stock gets them (inventory:read, or the kitchen's
    // kitchen:operate); for menu:read-only roles (cashier, waiter, marketing) `recipePortions` is left out of the product
    // (undefined), which is distinct from null = "no recipe" (review of PAR-03).
    const seesStock = ctx.can('inventory:read') || ctx.can('kitchen:operate');
    const portions = !seesStock ? [] : await tx.query<{ product_id: string; branch_id: string; portions: number }>(
      `select rc.product_id, b.id as branch_id,
              min(floor(greatest(coalesce(sl.quantity, 0), 0) / rc.quantity))::int as portions
         from recipe_components rc
         join branches b on b.org_id = rc.org_id and b.is_active
         left join stock_levels sl on sl.branch_id = b.id and sl.item_id = rc.item_id
        where rc.org_id = $1 and rc.product_id = any($2::uuid[])
        group by rc.product_id, b.id order by b.id`, [orgId, productIds]);
    const out: Product[] = [];
    for (const r of rows) {
      out.push(own.set({
        id: r.id, categoryId: r.category_id, name: r.name, nameAr: r.name_ar, description: r.description, descriptionAr: r.description_ar,
        priceMinor: r.price_minor, costMinor: r.cost_minor, currency: r.currency, station: r.station, prepMinutes: r.prep_minutes,
        spiceLevel: r.spice_level, dietary: r.dietary, allergens: r.allergens, ingredients: r.ingredients, calories: r.calories,
        imageUrl: null as string | null, imageMediaId: r.image_media_id, isActive: r.is_active, trackStock: r.track_stock,
        sortOrder: r.sort_order, externalRef: r.external_ref, version: r.version,
        branchSettings: settings.filter((s) => s.product_id === r.id).map((s) => ({
          branchId: s.branch_id, isAvailable: s.is_available, priceOverrideMinor: s.price_override_minor, stockQty: s.stock_qty,
          soldOut: s.sold_out_now, soldOutUntil: s.sold_out_now && s.sold_out_until ? new Date(s.sold_out_until).toISOString() : null,
          soldOutReason: s.sold_out_now ? s.sold_out_reason : null,
        })),
        modifierGroupIds: groups.filter((g) => g.product_id === r.id).map((g) => g.group_id),
        ...(seesStock ? {
          recipePortions: ((xs) => (xs.length ? xs.map((x) => ({ branchId: x.branch_id, portions: Number(x.portions) })) : null))(portions.filter((x) => x.product_id === r.id)),
        } : {}),
      } as Product, 'imageUrl', r.media_path, { fallback: r.image_url ?? null }));
    }
    return out;
  }

  /** Collector for public menu image URLs (guest routes resolve it after their transaction). */
  publicMediaUrls(): MediaUrls {
    return this.storage.urls(MENU_IMAGE_TTL_SECONDS);
  }

  private async loadGroups(tx: Tx, orgId: string, ids: string[] | null, activeOnly: boolean): Promise<ModifierGroup[]> {
    const groups = await tx.query<any>(
      `select * from modifier_groups where org_id = $1 and ($2::uuid[] is null or id = any($2::uuid[])) and (not $3 or is_active) order by created_at`,
      [orgId, ids, activeOnly]);
    if (!groups.length) return [];
    const options = await tx.query<any>('select * from modifier_options where group_id = any($1::uuid[]) order by sort_order, name', [groups.map((g) => g.id)]);
    return groups.map((g) => ({
      id: g.id, name: g.name, nameAr: g.name_ar, minSelect: g.min_select, maxSelect: g.max_select, isActive: g.is_active,
      options: options.filter((o) => o.group_id === g.id).map((o) => ({
        id: o.id, groupId: o.group_id, name: o.name, nameAr: o.name_ar, priceDeltaMinor: o.price_delta_minor, isDefault: o.is_default,
        isAvailable: o.is_available, sortOrder: o.sort_order,
      })),
    }));
  }

  private async changed(tx: Tx, ctx: TenantContext, action: string, entityType: string, entityId: string, metadata: Record<string, unknown> = {}) {
    await this.audit.record(tx, ctx, { action, entityType, entityId, metadata });
    await this.outbox.publish(tx, ctx.orgId, { type: 'menu.updated', aggregateType: entityType, aggregateId: entityId, payload: { action, ...metadata } });
  }

  // ---------------------------------------------------------------------------
  // Categories
  // ---------------------------------------------------------------------------
  private async defaultMenuId(tx: Tx, orgId: string): Promise<string> {
    const m = await tx.maybeOne<{ id: string }>('select id from menus where org_id = $1 order by branch_id nulls first, sort_order, created_at limit 1', [orgId]);
    if (m) return m.id;
    return (await tx.one<{ id: string }>(`insert into menus(org_id, name, name_ar) values ($1, 'Main menu', 'القائمة الرئيسية') returning id`, [orgId])).id;
  }

  async createCategory(ctx: TenantContext, input: { name: string; nameAr?: string | null; description?: string | null; defaultStation?: string | null; menuId?: string; isActive?: boolean }) {
    return this.db.scoped(ctx, async (tx) => {
      const menuId = input.menuId ?? await this.defaultMenuId(tx, ctx.orgId);
      if (input.menuId && !(await tx.maybeOne('select 1 from menus where id = $1', [input.menuId]))) throw notFound('Menu');
      const { next } = await tx.one<{ next: number }>('select coalesce(max(sort_order) + 1, 0)::int as next from menu_categories where menu_id = $1', [menuId]);
      const row = await tx.one(
        `insert into menu_categories(org_id, menu_id, name, name_ar, description, default_station, sort_order, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, coalesce($8, true)) returning *`,
        [ctx.orgId, menuId, input.name, input.nameAr ?? null, input.description ?? null, input.defaultStation ?? null, next, input.isActive ?? null]);
      await this.changed(tx, ctx, 'menu.category.created', 'menu_category', row.id);
      return toCategory(row);
    });
  }

  async updateCategory(ctx: TenantContext, id: string, input: Record<string, unknown>) {
    const map: Record<string, string> = { name: 'name', nameAr: 'name_ar', description: 'description', defaultStation: 'default_station', isActive: 'is_active' };
    const entries = Object.entries(input).filter(([k, v]) => map[k] && v !== undefined);
    return this.db.scoped(ctx, async (tx) => {
      const row = entries.length
        ? await tx.maybeOne(`update menu_categories set ${entries.map(([k], i) => `${map[k]} = $${i + 2}`).join(', ')} where id = $1 returning *`,
          [id, ...entries.map(([, v]) => v)])
        : await tx.maybeOne('select * from menu_categories where id = $1', [id]);
      if (!row) throw notFound('Category');
      if (entries.length) await this.changed(tx, ctx, 'menu.category.updated', 'menu_category', id, { fields: entries.map(([k]) => k) });
      return toCategory(row);
    });
  }

  async reorderCategories(ctx: TenantContext, ids: string[]) {
    return this.db.scoped(ctx, async (tx) => {
      const found = await tx.query<{ id: string }>('select id from menu_categories where id = any($1::uuid[])', [ids]);
      if (found.length !== new Set(ids).size) throw notFound('Category');
      await tx.query(
        `update menu_categories c set sort_order = o.ord - 1 from unnest($1::uuid[]) with ordinality as o(id, ord) where c.id = o.id`, [ids]);
      await this.changed(tx, ctx, 'menu.category.reordered', 'menu', ctx.orgId, { count: ids.length });
      return { ok: true };
    });
  }

  async archiveCategory(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne(`update menu_categories set is_active = false where id = $1 returning id`, [id]);
      if (!row) throw notFound('Category');
      await this.changed(tx, ctx, 'menu.category.archived', 'menu_category', id);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------------------
  // Products
  // ---------------------------------------------------------------------------
  async createProduct(ctx: TenantContext, input: ProductInput): Promise<Product> {
    const urls = this.storage.urls(MENU_IMAGE_TTL_SECONDS);
    const product = await this.db.scoped(ctx, async (tx) => {
      const cat = await tx.maybeOne<{ id: string; default_station: string | null }>('select id, default_station from menu_categories where id = $1', [input.categoryId]);
      if (!cat) throw notFound('Category');
      const org = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]);
      const { next } = await tx.one<{ next: number }>('select coalesce(max(sort_order) + 1, 0)::int as next from products where category_id = $1', [input.categoryId]);
      const row = await tx.one<{ id: string }>(
        `insert into products(org_id, category_id, name, name_ar, description, description_ar, price_minor, cost_minor, currency, station,
            prep_minutes, spice_level, dietary, allergens, ingredients, calories, image_url, is_active, track_stock, sort_order, external_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21) returning id`,
        [ctx.orgId, input.categoryId, input.name, input.nameAr ?? null, input.description ?? null, input.descriptionAr ?? null,
          input.priceMinor, input.costMinor ?? null, org.currency, input.station ?? cat.default_station ?? 'Kitchen',
          input.prepMinutes ?? null, input.spiceLevel ?? 0, input.dietary ?? [], input.allergens ?? [], input.ingredients ?? [],
          input.calories ?? null, input.imageUrl ?? null, input.isActive ?? true, input.trackStock ?? false, input.sortOrder ?? next,
          input.externalRef ?? null]);
      await this.changed(tx, ctx, 'menu.product.created', 'product', row.id);
      return (await this.loadProducts(tx, ctx, [row.id], urls))[0]!;
    });
    await urls.resolve();
    return product;
  }

  async updateProduct(ctx: TenantContext, id: string, input: ProductUpdate): Promise<Product> {
    const { version, ...patch } = input;
    const urls = this.storage.urls(MENU_IMAGE_TTL_SECONDS);
    const product = await this.db.scoped(ctx, async (tx) => {
      await this.patchProductTx(tx, ctx, id, patch, version);
      return (await this.loadProducts(tx, ctx, [id], urls))[0]!;
    });
    await urls.resolve();
    return product;
  }

  /**
   * A product edit inside the caller's transaction (the editor above, and change sets). `version` is the version the
   * editor loaded (mismatch: 409 stale_product); null when the caller checked the version itself under the same lock.
   */
  async patchProductTx(tx: Tx, ctx: TenantContext, id: string, patch: Omit<ProductUpdate, 'version'>, version: number | null): Promise<{ version: number }> {
    const entries = Object.entries(patch).filter(([k, v]) => PRODUCT_COLUMNS[k] && v !== undefined);
    const current = await tx.maybeOne<{ version: number; price_minor: number }>('select version, price_minor from products where id = $1 and org_id = $2 for update', [id, ctx.orgId]);
    if (!current) throw notFound('Product');
    if (version !== null && current.version !== version) throw conflict('stale_product', 'This item was changed by someone else. Refresh before saving.', { version: current.version });
    if (patch.categoryId && !(await tx.maybeOne('select 1 from menu_categories where id = $1', [patch.categoryId]))) throw notFound('Category');
    if (!entries.length) return { version: current.version };
    // A regular price edit ends a dish discount (21-STUDIO): the struck-through "was" price would no longer be true.
    const endsDiscount = patch.priceMinor !== undefined && patch.priceMinor !== current.price_minor;
    await tx.query(
      `update products set ${entries.map(([k], i) => `${PRODUCT_COLUMNS[k]} = $${i + 2}`).join(', ')}${endsDiscount ? ', compare_at_price_minor = null' : ''},
              version = version + 1 where id = $1`,
      [id, ...entries.map(([, v]) => v)]);
    await this.changed(tx, ctx, 'menu.product.updated', 'product', id, {
      fields: entries.map(([k]) => k), ...(patch.priceMinor !== undefined && patch.priceMinor !== current.price_minor ? { priceFrom: current.price_minor, priceTo: patch.priceMinor } : {}),
    });
    return { version: current.version + 1 };
  }

  /**
   * A percent discount on one dish (change-set op product.discount.set), in the caller's transaction. The original
   * price is kept in compare_at_price_minor (a second discount starts from it, not from the discounted price); 0 bps
   * restores it. Callers validate bounds and lock the row (the op's snapshot) before calling.
   */
  async setDiscountTx(tx: Tx, ctx: TenantContext, id: string, discountBps: number): Promise<{ version: number; priceMinor: number; compareAtMinor: number | null }> {
    const p = await tx.maybeOne<{ version: number; price_minor: number; compare_at_price_minor: number | null }>(
      'select version, price_minor, compare_at_price_minor from products where id = $1 and org_id = $2 for update', [id, ctx.orgId]);
    if (!p) throw notFound('Product');
    const original = Number(p.compare_at_price_minor ?? p.price_minor);
    const priceMinor = discountBps > 0 ? discountedPrice(original, discountBps) : original;
    const compareAtMinor = discountBps > 0 ? original : null;
    await tx.query('update products set price_minor = $2, compare_at_price_minor = $3, version = version + 1 where id = $1', [id, priceMinor, compareAtMinor]);
    await this.changed(tx, ctx, 'menu.product.discount_set', 'product', id, { discountBps, priceFrom: Number(p.price_minor), priceTo: priceMinor, compareAtMinor });
    return { version: p.version + 1, priceMinor, compareAtMinor };
  }

  async archiveProduct(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne(`update products set is_active = false, version = version + 1 where id = $1 returning id`, [id]);
      if (!row) throw notFound('Product');
      await this.changed(tx, ctx, 'menu.product.archived', 'product', id);
      return { ok: true };
    });
  }

  async uploadImage(ctx: TenantContext, id: string, file: { buffer: Buffer; mimetype: string } | undefined, alt?: string) {
    if (!file?.buffer?.length) throw invalid('file_required', 'Choose an image to upload');
    if (!file.mimetype.startsWith('image/')) throw invalid('unsupported_media', 'Upload a PNG, JPEG, WebP or GIF image');
    if (!(await this.db.scoped(ctx, (tx) => tx.maybeOne('select 1 from products where id = $1', [id])))) throw notFound('Product');
    // Upload and derivatives (CR-12) happen before the transaction (PCL-11); the transaction only records them.
    const stored = await this.storage.store(ctx, { bytes: file.buffer, contentType: file.mimetype, folder: 'menu' });
    const urls = this.storage.urls(MENU_IMAGE_TTL_SECONDS);
    const product = await this.db.scoped(ctx, async (tx) => {
      if (!(await tx.maybeOne('select 1 from products where id = $1 for update', [id]))) throw notFound('Product');
      const media = await this.storage.record(tx, ctx, stored, { alt });
      await tx.query('update products set image_media_id = $2, image_url = null, version = version + 1 where id = $1', [id, media.id]);
      await this.changed(tx, ctx, 'menu.product.image_uploaded', 'product', id, { mediaId: media.id });
      return (await this.loadProducts(tx, ctx, [id], urls))[0]!;
    });
    await urls.resolve();
    return product;
  }

  async setBranchSetting(ctx: TenantContext, productId: string, branchId: string, input: { isAvailable?: boolean; priceOverrideMinor?: number | null; stockQty?: number | null }) {
    ctx.assertBranch(branchId);
    return this.db.scoped(ctx, async (tx) => {
      if (!(await tx.maybeOne('select 1 from products where id = $1', [productId]))) throw notFound('Product');
      if (!(await tx.maybeOne('select 1 from branches where id = $1', [branchId]))) throw notFound('Branch');
      const row = await tx.one(
        `insert into product_branch_settings(org_id, product_id, branch_id, is_available, price_override_minor, stock_qty)
         values ($1, $2, $3, coalesce($4, true), $5, $6)
         on conflict (product_id, branch_id) do update set
           is_available = coalesce($4, product_branch_settings.is_available),
           price_override_minor = case when $7 then $5 else product_branch_settings.price_override_minor end,
           stock_qty = case when $8 then $6 else product_branch_settings.stock_qty end,
           updated_at = now()
         returning *`,
        [ctx.orgId, productId, branchId, input.isAvailable ?? null, input.priceOverrideMinor ?? null, input.stockQty ?? null,
          input.priceOverrideMinor !== undefined, input.stockQty !== undefined]);
      await this.changed(tx, ctx, 'menu.product.branch_updated', 'product', productId, { branchId, fields: Object.keys(input) });
      return { branchId, isAvailable: row.is_available, priceOverrideMinor: row.price_override_minor, stockQty: row.stock_qty };
    });
  }

  /** Quick 86 / restore from the kitchen, floor or menu (`menu:availability`): sold out, never "not offered". */
  async toggleAvailability(ctx: TenantContext, productId: string, branchId: string, available: boolean, opts: { until?: string | null; reason?: string | null } = {}) {
    ctx.assertBranch(branchId);
    return this.db.scoped(ctx, (tx) => this.setAvailability(tx, ctx, { productId, branchId, available, source: 'staff', until: opts.until, reason: opts.reason }));
  }

  /**
   * MENU_AVAILABILITY_PORT implementation (ResutoMCP, AI flows, KDS): marks a product sold out (86) or restores it at
   * one branch inside the caller's tenant transaction. Whether the branch offers the dish is unchanged (that is the
   * per-branch setting). `available` in the result is what guests can order now: offered and not sold out.
   */
  async setAvailability(tx: Tx, ctx: TenantContext, input: MenuAvailabilityInput): Promise<{ productId: string; branchId: string; available: boolean; offered: boolean; soldOut: boolean; soldOutUntil: string | null }> {
    ctx.assertBranch(input.branchId);
    if (!(await tx.maybeOne('select 1 from products where id = $1 and org_id = $2', [input.productId, ctx.orgId]))) throw notFound('Product');
    const branch = await tx.maybeOne<{ tz: string }>(
      `select coalesce(b.timezone, o.timezone) as tz from branches b join organizations o on o.id = b.org_id where b.id = $1 and b.org_id = $2`,
      [input.branchId, ctx.orgId]);
    if (!branch) throw notFound('Branch');
    let until: string | null = null;
    if (!input.available && input.until) {
      if (input.until === 'end_of_day') {
        until = (await tx.one<{ at: Date }>(`select (date_trunc('day', now() at time zone $1) + interval '1 day') at time zone $1 as at`, [branch.tz])).at.toISOString();
      } else {
        const at = new Date(input.until);
        if (Number.isNaN(at.getTime()) || at.getTime() <= Date.now()) throw invalid('invalid_until', 'Choose a time in the future to bring the dish back.');
        if (at.getTime() > Date.now() + 14 * 864e5) throw invalid('invalid_until', 'A dish can be marked sold out for at most 14 days.');
        until = at.toISOString();
      }
    }
    const actor = `${ctx.actorType}:${ctx.actorId ?? ''}`.slice(0, 120);
    const row = await tx.one<{ is_available: boolean; sold_out: boolean; sold_out_until: Date | null }>(
      `insert into product_branch_settings(org_id, product_id, branch_id, sold_out, sold_out_until, sold_out_reason, sold_out_at, sold_out_by)
       values ($1, $2, $3, $4, $5, $6, case when $4 then now() end, case when $4 then $7 end)
       on conflict (product_id, branch_id) do update set sold_out = $4, sold_out_until = $5, sold_out_reason = $6,
         sold_out_at = case when $4 then now() end, sold_out_by = case when $4 then $7 end, updated_at = now()
       returning is_available, sold_out, sold_out_until`,
      [ctx.orgId, input.productId, input.branchId, !input.available, input.available ? null : until,
        input.available ? null : input.reason?.trim().slice(0, 200) || null, actor]);
    await this.changed(tx, ctx, input.available ? 'menu.product.available' : 'menu.product.unavailable', 'product', input.productId,
      { branchId: input.branchId, available: input.available, source: input.source, reason: input.reason ?? null, until });
    return {
      productId: input.productId, branchId: input.branchId, offered: row.is_available, soldOut: row.sold_out,
      soldOutUntil: row.sold_out_until ? new Date(row.sold_out_until).toISOString() : null, available: row.is_available && !row.sold_out,
    };
  }

  /** Restores dishes whose 86 has expired (sold_out_until passed). Clearing the flag bumps each menu's version. */
  @Scheduled('menu.restore_86', 60)
  async restoreExpiredJob() {
    return this.restoreExpired();
  }

  async restoreExpired() {
    const rows = await this.db.withPlatform((tx) => tx.query<{ org_id: string; product_id: string; branch_id: string }>(
      `with cleared as (
         update product_branch_settings set sold_out = false, sold_out_until = null, sold_out_reason = null, sold_out_at = null, sold_out_by = null,
                updated_at = now()
          where sold_out and sold_out_until is not null and sold_out_until <= now()
          returning org_id, product_id, branch_id)
       , logged as (
         insert into audit_logs(org_id, branch_id, actor_type, actor_id, action, entity_type, entity_id, source, metadata)
         select org_id, branch_id, 'system', 'menu.restore_86', 'menu.product.available', 'product', product_id::text, 'worker',
                jsonb_build_object('branchId', branch_id, 'available', true, 'source', 'schedule')
           from cleared)
       select org_id, product_id, branch_id from cleared`), 'system:menu-restore-86');
    for (const r of rows) {
      await this.db.withTenant(r.org_id, (tx) => this.outbox.publish(tx, r.org_id, {
        type: 'menu.updated', aggregateType: 'product', aggregateId: r.product_id, payload: { action: 'menu.product.available', branchId: r.branch_id, source: 'schedule' },
      }), 'system:menu-restore-86');
    }
    return { restored: rows.length };
  }

  // ---------------------------------------------------------------------------
  // Modifiers
  // ---------------------------------------------------------------------------
  async createGroup(ctx: TenantContext, input: { name: string; nameAr?: string | null; minSelect: number; maxSelect: number; isActive?: boolean }) {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.one(
        `insert into modifier_groups(org_id, name, name_ar, min_select, max_select, is_active) values ($1, $2, $3, $4, $5, coalesce($6, true)) returning id`,
        [ctx.orgId, input.name, input.nameAr ?? null, input.minSelect, input.maxSelect, input.isActive ?? null]);
      await this.changed(tx, ctx, 'menu.modifier_group.created', 'modifier_group', row.id);
      return (await this.loadGroups(tx, ctx.orgId, [row.id], false))[0]!;
    });
  }

  async updateGroup(ctx: TenantContext, id: string, input: Record<string, unknown>) {
    const map: Record<string, string> = { name: 'name', nameAr: 'name_ar', minSelect: 'min_select', maxSelect: 'max_select', isActive: 'is_active' };
    const entries = Object.entries(input).filter(([k, v]) => map[k] && v !== undefined);
    return this.db.scoped(ctx, async (tx) => {
      const current = await tx.maybeOne<{ min_select: number; max_select: number }>('select min_select, max_select from modifier_groups where id = $1 for update', [id]);
      if (!current) throw notFound('Modifier group');
      const min = (input.minSelect as number | undefined) ?? current.min_select;
      const max = (input.maxSelect as number | undefined) ?? current.max_select;
      if (min > max) throw invalid('invalid_selection_range', 'Minimum selections cannot exceed the maximum');
      if (entries.length) {
        await tx.query(`update modifier_groups set ${entries.map(([k], i) => `${map[k]} = $${i + 2}`).join(', ')} where id = $1`, [id, ...entries.map(([, v]) => v)]);
        await this.changed(tx, ctx, 'menu.modifier_group.updated', 'modifier_group', id, { fields: entries.map(([k]) => k) });
      }
      return (await this.loadGroups(tx, ctx.orgId, [id], false))[0]!;
    });
  }

  async archiveGroup(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne('update modifier_groups set is_active = false where id = $1 returning id', [id]);
      if (!row) throw notFound('Modifier group');
      await this.changed(tx, ctx, 'menu.modifier_group.archived', 'modifier_group', id);
      return { ok: true };
    });
  }

  async createOption(ctx: TenantContext, groupId: string, input: { name: string; nameAr?: string | null; priceDeltaMinor: number; isDefault?: boolean; isAvailable?: boolean; sortOrder?: number }) {
    return this.db.scoped(ctx, async (tx) => {
      if (!(await tx.maybeOne('select 1 from modifier_groups where id = $1', [groupId]))) throw notFound('Modifier group');
      const { next } = await tx.one<{ next: number }>('select coalesce(max(sort_order) + 1, 0)::int as next from modifier_options where group_id = $1', [groupId]);
      const row = await tx.one(
        `insert into modifier_options(org_id, group_id, name, name_ar, price_delta_minor, is_default, is_available, sort_order)
         values ($1, $2, $3, $4, $5, coalesce($6, false), coalesce($7, true), $8) returning id`,
        [ctx.orgId, groupId, input.name, input.nameAr ?? null, input.priceDeltaMinor, input.isDefault ?? null, input.isAvailable ?? null, input.sortOrder ?? next]);
      await this.changed(tx, ctx, 'menu.modifier_option.created', 'modifier_option', row.id, { groupId });
      return (await this.loadGroups(tx, ctx.orgId, [groupId], false))[0]!;
    });
  }

  async updateOption(ctx: TenantContext, id: string, input: Record<string, unknown>) {
    const map: Record<string, string> = { name: 'name', nameAr: 'name_ar', priceDeltaMinor: 'price_delta_minor', isDefault: 'is_default', isAvailable: 'is_available', sortOrder: 'sort_order' };
    const entries = Object.entries(input).filter(([k, v]) => map[k] && v !== undefined);
    return this.db.scoped(ctx, async (tx) => {
      const row = entries.length
        ? await tx.maybeOne<{ group_id: string }>(`update modifier_options set ${entries.map(([k], i) => `${map[k]} = $${i + 2}`).join(', ')} where id = $1 returning group_id`,
          [id, ...entries.map(([, v]) => v)])
        : await tx.maybeOne<{ group_id: string }>('select group_id from modifier_options where id = $1', [id]);
      if (!row) throw notFound('Modifier option');
      if (entries.length) await this.changed(tx, ctx, 'menu.modifier_option.updated', 'modifier_option', id, { fields: entries.map(([k]) => k) });
      return (await this.loadGroups(tx, ctx.orgId, [row.group_id], false))[0]!;
    });
  }

  async deleteOption(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      // Options are snapshotted into order lines, so deleting one never rewrites history.
      const row = await tx.maybeOne('delete from modifier_options where id = $1 returning id', [id]);
      if (!row) throw notFound('Modifier option');
      await this.changed(tx, ctx, 'menu.modifier_option.deleted', 'modifier_option', id);
      return { ok: true };
    });
  }

  async assignGroups(ctx: TenantContext, productId: string, groupIds: string[]) {
    const urls = this.storage.urls(MENU_IMAGE_TTL_SECONDS);
    const product = await this.db.scoped(ctx, async (tx) => {
      if (!(await tx.maybeOne('select 1 from products where id = $1 for update', [productId]))) throw notFound('Product');
      const unique = [...new Set(groupIds)];
      const found = await tx.query('select id from modifier_groups where id = any($1::uuid[])', [unique]);
      if (found.length !== unique.length) throw notFound('Modifier group');
      await tx.query('delete from product_modifier_groups where product_id = $1', [productId]);
      for (const [i, g] of unique.entries()) {
        await tx.query('insert into product_modifier_groups(org_id, product_id, group_id, sort_order) values ($1, $2, $3, $4)', [ctx.orgId, productId, g, i]);
      }
      await tx.query('update products set version = version + 1 where id = $1', [productId]);
      await this.changed(tx, ctx, 'menu.product.modifiers_assigned', 'product', productId, { groupIds: unique });
      return (await this.loadProducts(tx, ctx, [productId], urls))[0]!;
    });
    await urls.resolve();
    return product;
  }

  // ---------------------------------------------------------------------------
  // Import (§8 rows) — preview never writes; commit requires an error-free preview
  // ---------------------------------------------------------------------------
  private async preview(tx: Tx, orgId: string, body: MenuImportRequest): Promise<MenuImportPreview> {
    const org = await tx.one<{ currency: 'EGP' | 'SAR' }>('select currency from organizations where id = $1', [orgId]);
    const rows = body.rows ?? csvToRows(body.csv!, org.currency);
    const existing = await tx.query<{ id: string; name: string; external_ref: string | null }>(
      'select id, name, external_ref from products where org_id = $1 and is_active', [orgId]);
    const categories = await tx.query<{ name: string }>('select name from menu_categories where org_id = $1 and is_active', [orgId]);
    return previewRows(rows, existing, categories.map((c) => c.name), body.source);
  }

  async importPreview(ctx: TenantContext, body: MenuImportRequest) {
    return this.db.scoped(ctx, (tx) => this.preview(tx, ctx.orgId, body));
  }

  async importCommit(ctx: TenantContext, body: MenuImportRequest, headerKey?: string) {
    const key = body.key ?? headerKey;
    if (!key) throw badRequest('idempotency_key_required', 'An idempotency key is required to import');
    const { key: _omit, ...payload } = body;
    return this.db.scoped(ctx, (tx) => this.idempotency.run(tx, ctx.orgId, 'menu-import', key, payload, async () => {
      const preview = await this.preview(tx, ctx.orgId, body);
      if (preview.summary.errors) throw new DomainError('import_has_errors', 'Correct all preview errors before importing.', 422, preview);
      const menuId = await this.defaultMenuId(tx, ctx.orgId);
      const org = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]);
      const categoryIds = new Map<string, string>();
      for (const c of await tx.query<{ id: string; name: string }>('select id, name from menu_categories where org_id = $1 and is_active order by sort_order', [ctx.orgId])) {
        if (!categoryIds.has(c.name.trim().toLowerCase())) categoryIds.set(c.name.trim().toLowerCase(), c.id);
      }
      let created = 0, updated = 0;
      const categoriesCreated: string[] = [];
      for (const { item, productId } of preview.rows) {
        const k = item.category.toLowerCase();
        let categoryId = categoryIds.get(k);
        if (!categoryId) {
          const { next } = await tx.one<{ next: number }>('select coalesce(max(sort_order) + 1, 0)::int as next from menu_categories where menu_id = $1', [menuId]);
          categoryId = (await tx.one<{ id: string }>(
            `insert into menu_categories(org_id, menu_id, name, sort_order) values ($1, $2, $3, $4) returning id`, [ctx.orgId, menuId, item.category, next])).id;
          categoryIds.set(k, categoryId);
          categoriesCreated.push(item.category);
        }
        if (productId) {
          await tx.query(
            `update products set name = $2, name_ar = coalesce($3, name_ar), category_id = $4, description = coalesce($5, description),
                price_minor = $6, station = $7, allergens = $8, is_active = true, version = version + 1 where id = $1`,
            [productId, item.name, item.nameAr, categoryId, item.description, item.priceMinor, item.station, item.allergens]);
          updated++;
        } else {
          const p = await tx.one<{ id: string }>(
            `insert into products(org_id, category_id, name, name_ar, description, price_minor, currency, station, allergens, external_ref)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
            [ctx.orgId, categoryId, item.name, item.nameAr, item.description, item.priceMinor, org.currency, item.station, item.allergens, item.externalId]);
          created++;
          if (!item.available) {
            // Imported drafts (POS/AI) start unavailable at every branch until reviewed (legacy behaviour).
            await tx.query(
              `insert into product_branch_settings(org_id, product_id, branch_id, is_available) select $1, $2, id, false from branches where org_id = $1`,
              [ctx.orgId, p.id]);
          }
        }
      }
      await this.changed(tx, ctx, 'menu.imported', 'menu', ctx.orgId, { source: body.source, created, updated, categoriesCreated });
      return { created, updated, categoriesCreated };
    }));
  }

  async exportCsvRows(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select p.external_ref, p.name, p.name_ar, c.name as category, p.description, p.price_minor, p.station, p.allergens, p.is_active
           from products p join menu_categories c on c.id = p.category_id where p.org_id = $1 and p.is_active order by c.sort_order, p.sort_order`, [ctx.orgId]);
      return rows.map((r) => ({
        externalId: r.external_ref ?? '', name: r.name, nameAr: r.name_ar ?? '', category: r.category, description: r.description ?? '',
        priceMinor: r.price_minor, station: r.station, allergens: (r.allergens as string[]).join('|'), available: r.is_active,
      }));
    });
  }

  // ---------------------------------------------------------------------------
  // Public menu (§8). Never exposes costs, stock counts or internal fields.
  // ---------------------------------------------------------------------------
  async resolveOrgBySlug(slug: string): Promise<{ id: string }> {
    const org = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string }>(
      `select id from organizations where slug = $1 and status <> 'closed'`, [slug.toLowerCase()]));
    if (!org) throw notFound('Restaurant');
    return org;
  }

  /** Organization and its current menu version, by slug (one statement; 404 for unknown or closed restaurants). */
  async publicMenuVersion(slug: string): Promise<{ orgId: string; version: string }> {
    const row = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string; version: string }>(
      `select o.id, coalesce(v.version, 0)::text as version from organizations o left join menu_versions v on v.org_id = o.id
        where o.slug = $1 and o.status <> 'closed'`, [slug.toLowerCase()]));
    if (!row) throw notFound('Restaurant');
    return { orgId: row.id, version: row.version };
  }

  /**
   * Public menu with its validator. The ETag changes exactly when the response can: a menu change (menu_versions),
   * a new image URL window (once a UTC day) or a new response shape. Built menus are reused from a bounded in-process
   * cache while the version is current, so a cache hit costs one indexed lookup instead of a menu build.
   *
   * The tag does not hash the body, so it is only given to a complete menu: when an image URL could not be signed (a
   * transient storage failure), the menu is neither cached here nor given an ETag (etag = null; the controllers send
   * it with Cache-Control: no-store), so nobody keeps an image-less menu for the rest of the version and URL window.
   */
  async cachedPublicMenu(slug: string, branchCode?: string): Promise<{ menu: PublicMenu; etag: string | null; orgId: string }> {
    const { orgId, version } = await this.publicMenuVersion(slug);
    const scope = createHash('sha256').update(`${orgId}|${branchCode ?? ''}`).digest('base64url').slice(0, 12);
    const tag = `pm${PUBLIC_MENU_SHAPE}-${version}-${stableExpiry(MENU_IMAGE_TTL_SECONDS)}-${scope}`;
    const hit = this.builtMenus.get(tag);
    if (hit) return { menu: hit, etag: `W/"${tag}"`, orgId };
    const { menu, complete } = await this.buildPublicMenu(slug, branchCode, orgId);
    if (!complete) return { menu, etag: null, orgId };
    this.builtMenus.set(tag, menu);
    return { menu, etag: `W/"${tag}"`, orgId };
  }

  async publicMenu(slug: string, branchCode?: string, orgId?: string): Promise<PublicMenu> {
    return (await this.buildPublicMenu(slug, branchCode, orgId)).menu;
  }

  /** The public menu and whether every image URL in it was signed. */
  private async buildPublicMenu(slug: string, branchCode?: string, orgId?: string): Promise<{ menu: PublicMenu; complete: boolean }> {
    const org = orgId ? { id: orgId } : await this.resolveOrgBySlug(slug);
    const urls = this.publicMediaUrls();
    const menu = await this.db.withTenant(org.id, async (tx) => {
      const branches = await tx.query<any>(`select ${PUBLIC_BRANCH_COLUMNS} from branches where org_id = $1 and is_active order by created_at`, [org.id]);
      const branch = branchCode ? branches.find((b) => b.code === branchCode) : branches[0];
      if (!branch) throw notFound('Branch');
      return this.publicMenuFor(tx, org.id, branch, branches, urls);
    }, 'guest:public-menu');
    const complete = await urls.resolve();
    return { menu, complete };
  }

  /**
   * Public menu for one branch inside an existing tenant transaction (guest sessions reuse it). The image URLs are
   * filled when the caller resolves `urls` after the transaction.
   */
  async publicMenuFor(tx: Tx, orgId: string, branch: any, branches: any[] | undefined, urls: MediaUrls): Promise<PublicMenu> {
    const media = urls;
    const org = await tx.one<any>('select name, name_ar, currency, slug, social_links from organizations where id = $1', [orgId]);
    const all = branches ?? await tx.query<any>(`select ${PUBLIC_BRANCH_COLUMNS} from branches where org_id = $1 and is_active order by created_at`, [orgId]);
    const categories = await tx.query<any>(
      `select c.id, c.name, c.name_ar from menu_categories c join menus m on m.id = c.menu_id
        where c.org_id = $1 and c.is_active and m.is_active and (m.branch_id is null or m.branch_id = $2) order by m.sort_order, c.sort_order, c.created_at`,
      [orgId, branch.id]);
    // SOLD_OUT_DISPLAY: products the branch does not offer (is_available = false) are not listed; a dish that is
    // sold out (86) or out of tracked stock is listed with `available: false` and its reason.
    const products = await tx.query<any>(
      `select p.id, p.category_id, p.name, p.name_ar, p.description, p.description_ar, coalesce(s.price_override_minor, p.price_minor) as price_minor,
              p.image_url, m.path as media_path, m.variants as media_variants, m.width as media_width, m.height as media_height, p.allergens, p.dietary, p.spice_level, p.prep_minutes,
              ${SOLD_OUT_SQL} as sold_out, ${IN_STOCK_SQL} as in_stock
         from products p
         left join product_branch_settings s on s.product_id = p.id and s.branch_id = $2
         left join media_assets m on m.id = p.image_media_id
        where p.org_id = $1 and p.is_active and ${OFFERED_SQL} and p.category_id = any($3::uuid[]) order by p.sort_order, p.created_at`,
      [orgId, branch.id, categories.map((c) => c.id)]);
    const links = products.length
      ? await tx.query<any>('select product_id, group_id from product_modifier_groups where product_id = any($1::uuid[]) order by sort_order', [products.map((p) => p.id)])
      : [];
    const groups = await this.loadGroups(tx, orgId, links.length ? [...new Set(links.map((l) => l.group_id))] : [], true);
    const groupById = new Map(groups.map((g) => [g.id, g]));
    const result: PublicMenu['categories'] = [];
    for (const c of categories) {
      const items = [];
      for (const p of products.filter((x) => x.category_id === c.id)) {
        items.push(media.set({
          id: p.id, name: p.name, nameAr: p.name_ar, description: p.description, descriptionAr: p.description_ar, priceMinor: p.price_minor,
          imageUrl: null as string | null, imageSrcSet: null as string | null,
          imageWidth: p.media_path ? p.media_width ?? null : null, imageHeight: p.media_path ? p.media_height ?? null : null,
          allergens: p.allergens, dietary: p.dietary, spiceLevel: p.spice_level, available: !p.sold_out && p.in_stock,
          unavailableReason: p.sold_out ? 'sold_out' as const : !p.in_stock ? 'out_of_stock' as const : null,
          prepMinutes: p.prep_minutes,
          modifierGroups: links.filter((l) => l.product_id === p.id).map((l) => groupById.get(l.group_id)).filter((g): g is ModifierGroup => !!g)
            .map((g) => ({
              id: g.id, name: g.name, nameAr: g.nameAr, minSelect: g.minSelect, maxSelect: g.maxSelect,
              options: g.options.map((o) => ({ id: o.id, name: o.name, nameAr: o.nameAr, priceDeltaMinor: o.priceDeltaMinor, available: o.isAvailable })),
            })),
        }, 'imageUrl', p.media_path, { fallback: p.image_url ?? null, variants: p.media_variants, minWidth: MENU_IMAGE_MIN_WIDTH, srcSetKey: 'imageSrcSet' }));
      }
      if (items.length) result.push({ id: c.id, name: c.name, nameAr: c.name_ar, products: items });
    }
    return {
      org: { name: org.name, nameAr: org.name_ar, currency: org.currency, slug: org.slug, socialLinks: socialLinksOf(org.social_links) },
      branch: toPublicBranch(branch), branches: all.map(toPublicBranch), categories: result,
    };
  }
}
