import { CHANGE_OPS, changeOpInputs, type ChangeOpInput } from '@resuto/contracts';
import type { TenantContext } from '../../../common/auth/context';
import type { Tx } from '../../../common/db/db.service';
import { invalid, notFound } from '../../../common/errors/domain-error';
import { requirePort, type MenuAvailabilityPort } from '../../kernel/ports';
import { OFFERED_SQL, SOLD_OUT_SQL } from '../../menu/availability';
import type { MenuService } from '../../menu/menu.service';
import { fmtMoney, isoOrNull, type OpHandler } from '../op-handler';

type ItemUpdate = ChangeOpInput<'menu.item.update'>;
type PriceSet = ChangeOpInput<'menu.item.price.set'>;
type AvailabilitySet = ChangeOpInput<'menu.item.availability.set'>;

const FIELDS: Array<[keyof Omit<ItemUpdate, 'productId'>, string, string]> = [
  ['name', 'name', 'Name'], ['nameAr', 'name_ar', 'Arabic name'], ['description', 'description', 'Description'],
  ['descriptionAr', 'description_ar', 'Arabic description'], ['isActive', 'is_active', 'Listed'],
];
/** A price may move at most this factor up or down in one change (guards against a misplaced digit). */
const MAX_PRICE_FACTOR = 10;

async function product(tx: Tx, ctx: TenantContext, productId: string, lock: boolean) {
  const row = await tx.maybeOne<any>(
    `select id, name, name_ar, description, description_ar, is_active, price_minor, currency, version from products
      where org_id = $1 and id = $2 ${lock ? 'for update' : ''}`, [ctx.orgId, productId]);
  if (!row) throw notFound('Product');
  return row;
}

const show = (v: unknown) => (v === null || v === undefined ? null : typeof v === 'boolean' ? (v ? 'yes' : 'no') : String(v));

export function menuOps(deps: { menu: MenuService; availability: () => MenuAvailabilityPort | null }): OpHandler[] {
  const itemUpdate: OpHandler<ItemUpdate> = {
    type: 'menu.item.update', meta: CHANGE_OPS['menu.item.update'], input: changeOpInputs['menu.item.update'],
    async validate(tx, ctx, input) {
      await product(tx, ctx, input.productId, false);
    },
    async snapshot(tx, ctx, input, lock) {
      const p = await product(tx, ctx, input.productId, lock);
      const before = Object.fromEntries(FIELDS.filter(([k]) => input[k] !== undefined).map(([k, col]) => [k, p[col] ?? null]));
      return { target: { type: 'product', id: p.id }, version: String(p.version), before };
    },
    async preview(tx, ctx, input, snap) {
      const p = await product(tx, ctx, input.productId, false);
      const after = Object.fromEntries(FIELDS.filter(([k]) => input[k] !== undefined).map(([k]) => [k, input[k] ?? null]));
      return {
        summary: `Edit menu item "${p.name}"`,
        changes: FIELDS.filter(([k]) => input[k] !== undefined).map(([k, , label]) => ({ label, before: show(snap.before?.[k]), after: show(input[k]) ?? '' })),
        after,
      };
    },
    async applyLocal(tx, ctx, input) {
      const { productId, ...patch } = input;
      const r = await deps.menu.patchProductTx(tx, ctx, productId, patch, null);
      return { productId, version: r.version };
    },
  };

  const priceSet: OpHandler<PriceSet> = {
    type: 'menu.item.price.set', meta: CHANGE_OPS['menu.item.price.set'], input: changeOpInputs['menu.item.price.set'],
    async validate(tx, ctx, input) {
      const p = await product(tx, ctx, input.productId, false);
      if (p.price_minor > 0 && (input.priceMinor > p.price_minor * MAX_PRICE_FACTOR || input.priceMinor * MAX_PRICE_FACTOR < p.price_minor)) {
        throw invalid('price_change_out_of_bounds', `A price can change at most ${MAX_PRICE_FACTOR} times up or down at once`,
          { currentMinor: p.price_minor, requestedMinor: input.priceMinor });
      }
    },
    async snapshot(tx, ctx, input, lock) {
      const p = await product(tx, ctx, input.productId, lock);
      return { target: { type: 'product', id: p.id }, version: String(p.version), before: { priceMinor: p.price_minor, currency: p.currency } };
    },
    async preview(tx, ctx, input, snap) {
      const p = await product(tx, ctx, input.productId, false);
      const from = Number(snap.before?.priceMinor ?? p.price_minor);
      const pct = from > 0 ? Math.round(((input.priceMinor - from) / from) * 1000) / 10 : null;
      return {
        summary: `Change the price of "${p.name}" from ${fmtMoney(from, p.currency)} to ${fmtMoney(input.priceMinor, p.currency)}${pct === null ? '' : ` (${pct > 0 ? '+' : ''}${pct}%)`}`,
        changes: [{ label: `Price of ${p.name}`, before: fmtMoney(from, p.currency), after: fmtMoney(input.priceMinor, p.currency) }],
        after: { priceMinor: input.priceMinor, currency: p.currency },
      };
    },
    async applyLocal(tx, ctx, input) {
      const r = await deps.menu.patchProductTx(tx, ctx, input.productId, { priceMinor: input.priceMinor }, null);
      return { productId: input.productId, priceMinor: input.priceMinor, version: r.version };
    },
  };

  async function atBranch(tx: Tx, ctx: TenantContext, input: AvailabilitySet, lock: boolean) {
    ctx.assertBranch(input.branchId);
    const row = await tx.maybeOne<any>(
      `select p.name, p.version, b.name as branch_name, ${OFFERED_SQL} as offered, ${SOLD_OUT_SQL} as sold_out, s.updated_at as settings_at
         from products p join branches b on b.org_id = p.org_id and b.id = $3
         left join product_branch_settings s on s.product_id = p.id and s.branch_id = b.id
        where p.org_id = $1 and p.id = $2 and p.is_active ${lock ? 'for update of p' : ''}`, [ctx.orgId, input.productId, input.branchId]);
    if (!row) throw notFound('Product');
    if (lock) await tx.query('select 1 from product_branch_settings where product_id = $1 and branch_id = $2 for update', [input.productId, input.branchId]);
    return row as { name: string; version: number; branch_name: string; offered: boolean; sold_out: boolean; settings_at: Date | null };
  }
  const word = (v: boolean) => (v ? 'available' : 'unavailable');

  const availabilitySet: OpHandler<AvailabilitySet> = {
    type: 'menu.item.availability.set', meta: CHANGE_OPS['menu.item.availability.set'], input: changeOpInputs['menu.item.availability.set'],
    available: () => !!deps.availability(),
    async validate(tx, ctx, input) {
      await atBranch(tx, ctx, input, false);
    },
    async snapshot(tx, ctx, input, lock) {
      const r = await atBranch(tx, ctx, input, lock);
      return {
        target: { type: 'product_branch', id: `${input.productId}:${input.branchId}` }, branchId: input.branchId,
        version: isoOrNull(r.settings_at) ?? 'none', before: { offered: r.offered, soldOut: r.sold_out, available: r.offered && !r.sold_out },
      };
    },
    async preview(tx, ctx, input, snap) {
      const r = await atBranch(tx, ctx, input, false);
      return {
        summary: `Mark "${r.name}" as ${word(input.available)} at ${r.branch_name}`,
        changes: [{ label: `Availability at ${r.branch_name}`, before: word(!!snap.before?.available), after: word(input.available) }],
        after: { available: input.available, ...(input.reason ? { reason: input.reason } : {}) },
      };
    },
    async applyLocal(tx, ctx, input, run) {
      const port = requirePort(deps.availability(), 'Menu availability');
      await atBranch(tx, ctx, input, false);
      const source = run.origin === 'mcp' ? 'mcp' : run.origin === 'staff' ? 'staff' : 'ai';
      return port.setAvailability(tx, ctx, { productId: input.productId, branchId: input.branchId, available: input.available, reason: input.reason ?? null, source });
    },
  };

  return [itemUpdate, priceSet, availabilitySet];
}
