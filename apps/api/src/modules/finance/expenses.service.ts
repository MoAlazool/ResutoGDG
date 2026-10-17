import { Injectable } from '@nestjs/common';
import type { ExpenseInput } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { StorageService } from '../../common/storage/storage.service';

const COLUMNS: Record<string, string> = {
  categoryId: 'category_id', branchId: 'branch_id', amountMinor: 'amount_minor', taxMinor: 'tax_minor', incurredOn: 'incurred_on',
  vendor: 'vendor', description: 'description', paymentMethod: 'payment_method', externalRef: 'external_ref',
};

/** Expense categories and expenses (with receipt files in tenant storage). */
@Injectable()
export class ExpensesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly storage: StorageService) {}

  async categories(ctx: TenantContext) {
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>('select id, name, name_ar, kind from expense_categories where org_id = $1 order by kind, name', [ctx.orgId]);
      return { items: rows.map((r) => ({ id: r.id, name: r.name, nameAr: r.name_ar, kind: r.kind })) };
    });
  }

  async createCategory(ctx: TenantContext, body: { name: string; nameAr?: string | null; kind: string }) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.one<any>('insert into expense_categories(org_id, name, name_ar, kind) values ($1, $2, $3, $4) returning id, name, name_ar, kind',
        [ctx.orgId, body.name, body.nameAr ?? null, body.kind]);
      await this.audit.record(tx, ctx, { action: 'expense_category.created', entityType: 'expense_category', entityId: r.id, metadata: { kind: body.kind } });
      return { id: r.id, name: r.name, nameAr: r.name_ar, kind: r.kind };
    });
  }

  private async toExpense(r: any) {
    return {
      id: r.id, branchId: r.branch_id, categoryId: r.category_id, categoryName: r.category_name ?? null, categoryKind: r.category_kind ?? null,
      amountMinor: r.amount_minor, taxMinor: r.tax_minor, netMinor: r.amount_minor - r.tax_minor, currency: r.currency, incurredOn: r.incurred_on,
      vendor: r.vendor, description: r.description, paymentMethod: r.payment_method, externalRef: r.external_ref, source: r.source,
      receiptMediaId: r.receipt_media_id, receiptUrl: r.receipt_path ? await this.storage.signedUrl(r.receipt_path, 600) : null,
      createdBy: r.created_by, createdAt: new Date(r.created_at).toISOString(),
    };
  }

  private async load(tx: Tx, id: string) {
    const r = await tx.maybeOne<any>(
      `select e.*, c.name as category_name, c.kind as category_kind, m.path as receipt_path from expenses e join expense_categories c on c.id = e.category_id
         left join media_assets m on m.id = e.receipt_media_id where e.id = $1`, [id]);
    if (!r) throw notFound('Expense');
    return r;
  }

  async list(ctx: TenantContext, q: { from?: string; to?: string; categoryId?: string; branchId?: string; limit: number; cursor?: string }) {
    if (q.branchId) ctx.assertBranch(q.branchId);
    return this.db.scoped(ctx, async (tx) => {
      const [cDate, cId] = q.cursor ? Buffer.from(q.cursor, 'base64url').toString().split('|') : [null, null];
      const rows = await tx.query<any>(
        `select e.*, c.name as category_name, c.kind as category_kind, m.path as receipt_path from expenses e join expense_categories c on c.id = e.category_id
           left join media_assets m on m.id = e.receipt_media_id
          where e.org_id = $1 and ($2::date is null or e.incurred_on >= $2) and ($3::date is null or e.incurred_on <= $3)
            and ($4::uuid is null or e.category_id = $4) and ($5::uuid is null or e.branch_id = $5)
            and ($6::date is null or (e.incurred_on, e.id) < ($6::date, $7::uuid))
          order by e.incurred_on desc, e.id desc limit $8`,
        [ctx.orgId, q.from ?? null, q.to ?? null, q.categoryId ?? null, q.branchId ?? null, cDate || null, cId || null, q.limit]);
      const items = await Promise.all(rows.map((r) => this.toExpense(r)));
      const last = rows[rows.length - 1];
      const totals = await tx.one<any>(
        `select coalesce(sum(amount_minor), 0)::bigint as amount, coalesce(sum(tax_minor), 0)::bigint as tax, count(*)::int as n from expenses
          where org_id = $1 and ($2::date is null or incurred_on >= $2) and ($3::date is null or incurred_on <= $3)
            and ($4::uuid is null or category_id = $4) and ($5::uuid is null or branch_id = $5)`,
        [ctx.orgId, q.from ?? null, q.to ?? null, q.categoryId ?? null, q.branchId ?? null]);
      return { items, nextCursor: rows.length === q.limit && last ? Buffer.from(`${last.incurred_on}|${last.id}`).toString('base64url') : null,
        totals: { count: totals.n, amountMinor: Number(totals.amount), taxMinor: Number(totals.tax), netMinor: Number(totals.amount) - Number(totals.tax) } };
    });
  }

  async get(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await this.load(tx, id);
      ctx.assertBranch(r.branch_id);
      return this.toExpense(r);
    });
  }

  private async assertRefs(tx: Tx, ctx: TenantContext, categoryId?: string, branchId?: string | null) {
    if (categoryId && !(await tx.maybeOne('select 1 from expense_categories where id = $1', [categoryId]))) throw notFound('Expense category');
    if (branchId) {
      ctx.assertBranch(branchId);
      if (!(await tx.maybeOne('select 1 from branches where id = $1', [branchId]))) throw notFound('Branch');
    } else if (branchId === null && ctx.branchIds !== null) {
      throw invalid('branch_required', 'Choose one of your branches');
    }
  }

  async create(ctx: TenantContext, body: ExpenseInput) {
    return this.db.scoped(ctx, async (tx) => {
      await this.assertRefs(tx, ctx, body.categoryId, body.branchId ?? null);
      const org = await tx.one<any>('select currency from organizations where id = $1', [ctx.orgId]);
      const r = await tx.one<any>(
        `insert into expenses(org_id, branch_id, category_id, amount_minor, tax_minor, currency, incurred_on, vendor, description, payment_method, external_ref, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [ctx.orgId, body.branchId ?? null, body.categoryId, body.amountMinor, body.taxMinor ?? 0, org.currency, body.incurredOn, body.vendor ?? null,
          body.description ?? null, body.paymentMethod ?? null, body.externalRef ?? null, ctx.userId]);
      await this.audit.record(tx, ctx, { action: 'expense.created', entityType: 'expense', entityId: r.id, branchId: body.branchId ?? null, metadata: { amountMinor: body.amountMinor } });
      return this.toExpense(await this.load(tx, r.id));
    });
  }

  async update(ctx: TenantContext, id: string, patch: Partial<ExpenseInput>) {
    return this.db.scoped(ctx, async (tx) => {
      const cur = await this.load(tx, id);
      ctx.assertBranch(cur.branch_id);
      const entries = Object.entries(patch).filter(([k, v]) => v !== undefined && COLUMNS[k]);
      if (patch.categoryId !== undefined || patch.branchId !== undefined) await this.assertRefs(tx, ctx, patch.categoryId, patch.branchId);
      const amount = patch.amountMinor ?? cur.amount_minor, taxV = patch.taxMinor ?? cur.tax_minor;
      if (taxV > amount) throw invalid('tax_exceeds_amount', 'Tax cannot exceed the amount');
      if (entries.length) {
        await tx.query(`update expenses set ${entries.map(([k], i) => `${COLUMNS[k]} = $${i + 2}`).join(', ')} where id = $1`, [id, ...entries.map(([, v]) => v)]);
        await this.audit.record(tx, ctx, { action: 'expense.updated', entityType: 'expense', entityId: id, branchId: cur.branch_id, metadata: { fields: entries.map(([k]) => k) } });
      }
      return this.toExpense(await this.load(tx, id));
    });
  }

  async remove(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const cur = await this.load(tx, id);
      ctx.assertBranch(cur.branch_id);
      if (cur.source === 'integration') throw conflict('expense_synced', 'This expense is synced from an integration; remove it there');
      await tx.query('delete from expenses where id = $1', [id]);
      await this.audit.record(tx, ctx, { action: 'expense.deleted', entityType: 'expense', entityId: id, branchId: cur.branch_id,
        metadata: { amountMinor: cur.amount_minor, incurredOn: cur.incurred_on, categoryId: cur.category_id } });
      return { deleted: true };
    });
  }

  async attachReceipt(ctx: TenantContext, id: string, file: { buffer: Buffer; mimetype: string } | undefined) {
    if (!file?.buffer?.length) throw invalid('file_required', 'Choose a receipt image or PDF');
    return this.db.scoped(ctx, async (tx) => {
      const cur = await this.load(tx, id);
      ctx.assertBranch(cur.branch_id);
      const media = await this.storage.put(tx, ctx, { bytes: file.buffer, contentType: file.mimetype, folder: 'expense-receipts' });
      await tx.query('update expenses set receipt_media_id = $2 where id = $1', [id, media.id]);
      await this.audit.record(tx, ctx, { action: 'expense.receipt_attached', entityType: 'expense', entityId: id, branchId: cur.branch_id, metadata: { mediaId: media.id } });
      return this.toExpense(await this.load(tx, id));
    });
  }
}
