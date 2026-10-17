import { Injectable } from '@nestjs/common';
import type {
  Category, MenuEditorView, MenuImportPreview, MenuImportRequest, ModifierGroup, Product, ProductInput, ProductUpdate, PublicBranch, PublicMenu,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { StorageService } from '../../common/storage/storage.service';
import { csvToRows, previewRows } from './menu-import';

/** Cross-module port for ResutoMCP; the lead's kernel/ports.ts declares the same Symbol.for token. */
export const MENU_AVAILABILITY_PORT = Symbol.for('resuto.MENU_AVAILABILITY_PORT');
export interface MenuAvailabilityInput { productId: string; branchId: string; available: boolean; reason?: string | null; source: 'staff' | 'mcp' | 'ai' }

const PRODUCT_COLUMNS: Record<string, string> = {
  categoryId: 'category_id', name: 'name', nameAr: 'name_ar', description: 'description', descriptionAr: 'description_ar',
  priceMinor: 'price_minor', costMinor: 'cost_minor', station: 'station', prepMinutes: 'prep_minutes', spiceLevel: 'spice_level',
  dietary: 'dietary', allergens: 'allergens', ingredients: 'ingredients', calories: 'calories', imageUrl: 'image_url',
  isActive: 'is_active', trackStock: 'track_stock', sortOrder: 'sort_order', externalRef: 'external_ref',
};

export const toCategory = (r: any): Category => ({
  id: r.id, menuId: r.menu_id, name: r.name, nameAr: r.name_ar, description: r.description, defaultStation: r.default_station,
  sortOrder: r.sort_order, isActive: r.is_active,
});

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
    return this.db.scoped(ctx, async (tx) => {
      const org = await tx.one<{ currency: string }>('select currency from organizations where id = $1', [ctx.orgId]);
      const menus = await tx.query('select id, name, name_ar, branch_id, is_active from menus where org_id = $1 order by sort_order, created_at', [ctx.orgId]);
      const categories = await tx.query('select * from menu_categories where org_id = $1 order by sort_order, created_at', [ctx.orgId]);
      const products = await this.loadProducts(tx, ctx.orgId, null);
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
  }

  async getProduct(ctx: TenantContext, productId: string): Promise<Product> {
    return this.db.scoped(ctx, async (tx) => {
      const [p] = await this.loadProducts(tx, ctx.orgId, [productId]);
      if (!p) throw notFound('Product');
      return p;
    });
  }

  private async loadProducts(tx: Tx, orgId: string, ids: string[] | null): Promise<Product[]> {
    const rows = await tx.query<any>(
      `select p.*, m.path as media_path from products p left join media_assets m on m.id = p.image_media_id
        where p.org_id = $1 and ($2::uuid[] is null or p.id = any($2::uuid[])) order by p.sort_order, p.created_at`, [orgId, ids]);
    if (!rows.length) return [];
    const productIds = rows.map((r) => r.id);
    const settings = await tx.query<any>('select * from product_branch_settings where product_id = any($1::uuid[])', [productIds]);
    const groups = await tx.query<any>('select product_id, group_id from product_modifier_groups where product_id = any($1::uuid[]) order by sort_order', [productIds]);
    const out: Product[] = [];
    for (const r of rows) {
      out.push({
        id: r.id, categoryId: r.category_id, name: r.name, nameAr: r.name_ar, description: r.description, descriptionAr: r.description_ar,
        priceMinor: r.price_minor, costMinor: r.cost_minor, currency: r.currency, station: r.station, prepMinutes: r.prep_minutes,
        spiceLevel: r.spice_level, dietary: r.dietary, allergens: r.allergens, ingredients: r.ingredients, calories: r.calories,
        imageUrl: await this.imageUrl(r), imageMediaId: r.image_media_id, isActive: r.is_active, trackStock: r.track_stock,
        sortOrder: r.sort_order, externalRef: r.external_ref, version: r.version,
        branchSettings: settings.filter((s) => s.product_id === r.id).map((s) => ({
          branchId: s.branch_id, isAvailable: s.is_available, priceOverrideMinor: s.price_override_minor, stockQty: s.stock_qty,
        })),
        modifierGroupIds: groups.filter((g) => g.product_id === r.id).map((g) => g.group_id),
      });
    }
    return out;
  }

  private async imageUrl(r: { media_path?: string | null; image_url?: string | null }): Promise<string | null> {
    if (r.media_path) return this.storage.signedUrl(r.media_path, 24 * 3600).catch(() => null);
    return r.image_url ?? null;
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
    return this.db.scoped(ctx, async (tx) => {
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
      return (await this.loadProducts(tx, ctx.orgId, [row.id]))[0]!;
    });
  }

  async updateProduct(ctx: TenantContext, id: string, input: ProductUpdate): Promise<Product> {
    const { version, ...patch } = input;
    const entries = Object.entries(patch).filter(([k, v]) => PRODUCT_COLUMNS[k] && v !== undefined);
    return this.db.scoped(ctx, async (tx) => {
      const current = await tx.maybeOne<{ version: number; price_minor: number }>('select version, price_minor from products where id = $1 for update', [id]);
      if (!current) throw notFound('Product');
      if (current.version !== version) throw conflict('stale_product', 'This item was changed by someone else. Refresh before saving.', { version: current.version });
      if (patch.categoryId && !(await tx.maybeOne('select 1 from menu_categories where id = $1', [patch.categoryId]))) throw notFound('Category');
      if (entries.length) {
        await tx.query(
          `update products set ${entries.map(([k], i) => `${PRODUCT_COLUMNS[k]} = $${i + 2}`).join(', ')}, version = version + 1 where id = $1`,
          [id, ...entries.map(([, v]) => v)]);
        await this.changed(tx, ctx, 'menu.product.updated', 'product', id, {
          fields: entries.map(([k]) => k), ...(patch.priceMinor !== undefined && patch.priceMinor !== current.price_minor ? { priceFrom: current.price_minor, priceTo: patch.priceMinor } : {}),
        });
      }
      return (await this.loadProducts(tx, ctx.orgId, [id]))[0]!;
    });
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
    return this.db.scoped(ctx, async (tx) => {
      if (!(await tx.maybeOne('select 1 from products where id = $1 for update', [id]))) throw notFound('Product');
      if (!file.mimetype.startsWith('image/')) throw invalid('unsupported_media', 'Upload a PNG, JPEG, WebP or GIF image');
      const media = await this.storage.put(tx, ctx, { bytes: file.buffer, contentType: file.mimetype, folder: 'menu', alt });
      await tx.query('update products set image_media_id = $2, image_url = null, version = version + 1 where id = $1', [id, media.id]);
      await this.changed(tx, ctx, 'menu.product.image_uploaded', 'product', id, { mediaId: media.id });
      return (await this.loadProducts(tx, ctx.orgId, [id]))[0]!;
    });
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

  /** Quick 86 / un-86 from the kitchen or floor (`menu:availability`). */
  async toggleAvailability(ctx: TenantContext, productId: string, branchId: string, available: boolean) {
    ctx.assertBranch(branchId);
    return this.db.scoped(ctx, (tx) => this.setAvailability(tx, ctx, { productId, branchId, available, source: 'staff' }));
  }

  /**
   * MENU_AVAILABILITY_PORT implementation (ResutoMCP, AI flows): marks a product
   * available/unavailable at one branch inside the caller's tenant transaction.
   */
  async setAvailability(tx: Tx, ctx: TenantContext, input: MenuAvailabilityInput): Promise<{ productId: string; branchId: string; available: boolean }> {
    ctx.assertBranch(input.branchId);
    if (!(await tx.maybeOne('select 1 from products where id = $1 and org_id = $2', [input.productId, ctx.orgId]))) throw notFound('Product');
    if (!(await tx.maybeOne('select 1 from branches where id = $1 and org_id = $2', [input.branchId, ctx.orgId]))) throw notFound('Branch');
    await tx.query(
      `insert into product_branch_settings(org_id, product_id, branch_id, is_available) values ($1, $2, $3, $4)
       on conflict (product_id, branch_id) do update set is_available = $4, updated_at = now()`,
      [ctx.orgId, input.productId, input.branchId, input.available]);
    await this.changed(tx, ctx, input.available ? 'menu.product.available' : 'menu.product.unavailable', 'product', input.productId,
      { branchId: input.branchId, available: input.available, source: input.source, reason: input.reason ?? null });
    return { productId: input.productId, branchId: input.branchId, available: input.available };
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
    return this.db.scoped(ctx, async (tx) => {
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
      return (await this.loadProducts(tx, ctx.orgId, [productId]))[0]!;
    });
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
    if (!key) throw invalid('idempotency_key_required', 'An idempotency key is required to import');
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

  async publicMenu(slug: string, branchCode?: string): Promise<PublicMenu> {
    const org = await this.resolveOrgBySlug(slug);
    return this.db.withTenant(org.id, async (tx) => {
      const branches = await tx.query<any>('select * from branches where org_id = $1 and is_active order by created_at', [org.id]);
      const branch = branchCode ? branches.find((b) => b.code === branchCode) : branches[0];
      if (!branch) throw notFound('Branch');
      return this.publicMenuFor(tx, org.id, branch, branches);
    }, 'guest:public-menu');
  }

  /** Public menu for one branch inside an existing tenant transaction (guest sessions reuse it). */
  async publicMenuFor(tx: Tx, orgId: string, branch: any, branches?: any[]): Promise<PublicMenu> {
    const org = await tx.one<any>('select name, name_ar, currency, slug from organizations where id = $1', [orgId]);
    const all = branches ?? await tx.query<any>('select * from branches where org_id = $1 and is_active order by created_at', [orgId]);
    const categories = await tx.query<any>(
      `select c.id, c.name, c.name_ar from menu_categories c join menus m on m.id = c.menu_id
        where c.org_id = $1 and c.is_active and m.is_active and (m.branch_id is null or m.branch_id = $2) order by m.sort_order, c.sort_order, c.created_at`,
      [orgId, branch.id]);
    const products = await tx.query<any>(
      `select p.id, p.category_id, p.name, p.name_ar, p.description, p.description_ar, coalesce(s.price_override_minor, p.price_minor) as price_minor,
              p.image_url, m.path as media_path, p.allergens, p.dietary, p.spice_level, p.prep_minutes,
              (coalesce(s.is_available, true) and (not p.track_stock or s.stock_qty is null or s.stock_qty > 0)) as available
         from products p
         left join product_branch_settings s on s.product_id = p.id and s.branch_id = $2
         left join media_assets m on m.id = p.image_media_id
        where p.org_id = $1 and p.is_active and p.category_id = any($3::uuid[]) order by p.sort_order, p.created_at`,
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
        items.push({
          id: p.id, name: p.name, nameAr: p.name_ar, description: p.description, descriptionAr: p.description_ar, priceMinor: p.price_minor,
          imageUrl: await this.imageUrl(p), allergens: p.allergens, dietary: p.dietary, spiceLevel: p.spice_level, available: p.available,
          prepMinutes: p.prep_minutes,
          modifierGroups: links.filter((l) => l.product_id === p.id).map((l) => groupById.get(l.group_id)).filter((g): g is ModifierGroup => !!g)
            .map((g) => ({
              id: g.id, name: g.name, nameAr: g.nameAr, minSelect: g.minSelect, maxSelect: g.maxSelect,
              options: g.options.map((o) => ({ id: o.id, name: o.name, nameAr: o.nameAr, priceDeltaMinor: o.priceDeltaMinor, available: o.isAvailable })),
            })),
        });
      }
      if (items.length) result.push({ id: c.id, name: c.name, nameAr: c.name_ar, products: items });
    }
    return {
      org: { name: org.name, nameAr: org.name_ar, currency: org.currency, slug: org.slug },
      branch: toPublicBranch(branch), branches: all.map(toPublicBranch), categories: result,
    };
  }
}
