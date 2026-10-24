import { Injectable } from '@nestjs/common';
import { PRINT_JOB_CLAIM_SECONDS, type Page, type PosPrintJob } from '@resuto/contracts';
import type { z } from 'zod';
import type { posPrintJobsQuery } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { conflict, notFound } from '../../common/errors/domain-error';
import { cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { deviceBranch } from './pos-feed.service';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const JOB_COLUMNS = 'j.id, j.kind, j.status, j.order_id, j.station, j.claimed_by, j.claimed_at, j.attempts, j.completed_at, j.error, j.created_at';

const toJob = (r: any): PosPrintJob => ({
  id: r.id, kind: r.kind, status: r.status, orderId: r.order_id, station: r.station, claimedBy: r.claimed_by, claimedAt: iso(r.claimed_at),
  attempts: r.attempts, completedAt: iso(r.completed_at), error: r.error, createdAt: iso(r.created_at)!,
});

/**
 * Print jobs (21-POSAPI): a kitchen ticket per station when the kitchen may start an order (written by the feed
 * trigger, announced as print_job.created) and receipts a device asks for. The document is structured content the
 * device lays out for its printer (ESC/POS over TCP 9100, Epson ePOS, Star StarPRNT); the API never sends printer
 * bytes. One device prints a job: it claims it (another device may take over a claim older than
 * PRINT_JOB_CLAIM_SECONDS, or a failed job), prints, then completes it as printed or failed.
 */
@Injectable()
export class PosPrintService {
  constructor(private readonly db: DbService) {}

  async list(ctx: TenantContext, q: z.infer<typeof posPrintJobsQuery>): Promise<Page<PosPrintJob>> {
    const branchId = deviceBranch(ctx);
    const k = keyset(q.cursor, { direction: 'asc' });
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select ${JOB_COLUMNS}, ${cursorAt('j.created_at')} as cursor_at from pos_print_jobs j
          where j.branch_id = $1 and ($2::text is null or j.status = $2) and ($3::text is null or j.kind = $3) and ($4::text is null or j.station = $4)
            ${k.after('j.created_at', 'j.id', 5)}
          order by j.created_at, j.id limit ${k.fetch(q.limit)}`, [branchId, q.status ?? null, q.kind ?? null, q.station ?? null, ...k.params]);
      return pageOf(rows, q.limit, (r) => ({ at: r.cursor_at, id: r.id }), toJob);
    });
  }

  async get(ctx: TenantContext, id: string): Promise<PosPrintJob> {
    const branchId = deviceBranch(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne<any>(`select ${JOB_COLUMNS} from pos_print_jobs j where j.id = $1 and j.branch_id = $2`, [id, branchId]);
      if (!r) throw notFound('Print job');
      return { ...toJob(r), document: await this.document(tx, r) };
    });
  }

  /** A receipt for an order; the same client request id returns the same job. */
  async receipt(ctx: TenantContext, orderId: string, clientRequestId: string): Promise<PosPrintJob> {
    const branchId = deviceBranch(ctx);
    return this.db.scoped(ctx, async (tx) => {
      if (!(await tx.maybeOne('select 1 from orders where id = $1 and branch_id = $2', [orderId, branchId]))) throw notFound('Order');
      let r = await tx.maybeOne<any>(
        `insert into pos_print_jobs as j (org_id, branch_id, kind, order_id, client_request_id, requested_by)
         values ($1, $2, 'receipt', $3, $4, $5) on conflict (org_id, client_request_id) do nothing returning ${JOB_COLUMNS}`,
        [ctx.orgId, branchId, orderId, clientRequestId, `device:${ctx.actorId}`]);
      if (!r) {
        r = await tx.one<any>(`select ${JOB_COLUMNS}, j.branch_id from pos_print_jobs j where j.org_id = $1 and j.client_request_id = $2`, [ctx.orgId, clientRequestId]);
        if (r.order_id !== orderId || r.branch_id !== branchId || r.kind !== 'receipt') {
          throw conflict('client_request_id_reused', 'This client request id was already used for another print job.');
        }
      }
      return { ...toJob(r), document: await this.document(tx, r) };
    });
  }

  async claim(ctx: TenantContext, id: string): Promise<PosPrintJob> {
    const branchId = deviceBranch(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne<any>(
        `update pos_print_jobs j set status = 'claimed', claimed_by = $3, claimed_at = now(), attempts = attempts + 1, error = null
          where j.id = $1 and j.branch_id = $2
            and (j.status in ('pending', 'failed') or (j.status = 'claimed' and (j.claimed_by = $3 or j.claimed_at < now() - make_interval(secs => $4))))
          returning ${JOB_COLUMNS}`, [id, branchId, ctx.actorId, PRINT_JOB_CLAIM_SECONDS]);
      if (!r) {
        const cur = await tx.maybeOne<any>('select status, claimed_by from pos_print_jobs where id = $1 and branch_id = $2', [id, branchId]);
        if (!cur) throw notFound('Print job');
        const details = { status: cur.status, claimedBy: cur.claimed_by };
        if (cur.status === 'printed') throw conflict('print_job_completed', 'This job was already printed.', details);
        throw conflict('print_job_claimed', 'Another device is printing this job.', details);
      }
      return { ...toJob(r), document: await this.document(tx, r) };
    });
  }

  async complete(ctx: TenantContext, id: string, status: 'printed' | 'failed', error?: string | null): Promise<PosPrintJob> {
    const branchId = deviceBranch(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne<any>(
        `update pos_print_jobs j set status = $4, completed_at = now(), error = $5
          where j.id = $1 and j.branch_id = $2 and j.status = 'claimed' and j.claimed_by = $3 returning ${JOB_COLUMNS}`,
        [id, branchId, ctx.actorId, status, status === 'failed' ? error?.trim() || 'failed' : null]);
      if (!r) {
        if (!(await tx.maybeOne('select 1 from pos_print_jobs where id = $1 and branch_id = $2', [id, branchId]))) throw notFound('Print job');
        throw conflict('print_job_not_claimed', 'Claim the job before completing it.');
      }
      return toJob(r);
    });
  }

  /** Structured content of a kitchen ticket (the station's lines) or a receipt (lines, totals, payments). */
  private async document(tx: Tx, job: { kind: string; order_id: string; station: string | null }): Promise<Record<string, unknown>> {
    const o = await tx.one<any>(
      `select o.*, t.label as table_label, b.name as branch_name, b.name_ar as branch_name_ar, b.address as branch_address, b.phone as branch_phone,
              g.name as org_name, g.name_ar as org_name_ar, g.legal_name, g.tax_registration_number
         from orders o join branches b on b.id = o.branch_id join organizations g on g.id = o.org_id left join dining_tables t on t.id = o.table_id
        where o.id = $1`, [job.order_id]);
    const lines = await tx.query<any>(
      `select name, name_ar, quantity, unit_price_minor, modifiers, modifiers_total_minor, line_total_minor, station, kitchen_status, notes
         from order_lines where order_id = $1 and ($2::text is null or station = $2) order by line_seq`, [job.order_id, job.kind === 'kitchen_ticket' ? job.station : null]);
    const order = {
      id: o.id, number: o.number, publicRef: o.public_ref, fulfillment: o.fulfillment, channel: o.channel, tableLabel: o.table_label,
      customerName: o.customer_name, notes: o.notes, placedAt: iso(o.placed_at), scheduledFor: iso(o.scheduled_for), status: o.status,
    };
    const mods = (m: any) => (Array.isArray(m) ? m : []).map((x) => ({ group: x.group ?? null, option: x.option, optionAr: x.optionAr ?? null, priceDeltaMinor: x.priceDeltaMinor ?? 0 }));
    if (job.kind === 'kitchen_ticket') {
      return {
        type: 'kitchen_ticket', version: 1, station: job.station, branch: { name: o.branch_name, nameAr: o.branch_name_ar }, order,
        lines: lines.map((l) => ({ name: l.name, nameAr: l.name_ar, quantity: l.quantity, modifiers: mods(l.modifiers), notes: l.notes, kitchenStatus: l.kitchen_status })),
      };
    }
    const payments = await tx.query<any>(
      `select p.method, p.provider, a.amount_minor, p.created_at from payment_allocations a join payments p on p.id = a.payment_id
        where a.order_id = $1 and p.status in ('succeeded', 'partially_refunded', 'refunded') order by a.id`, [job.order_id]);
    return {
      type: 'receipt', version: 1, currency: o.currency,
      org: { name: o.org_name, nameAr: o.org_name_ar, legalName: o.legal_name, taxRegistrationNumber: o.tax_registration_number },
      branch: { name: o.branch_name, nameAr: o.branch_name_ar, address: o.branch_address, phone: o.branch_phone },
      order,
      lines: lines.map((l) => ({ name: l.name, nameAr: l.name_ar, quantity: l.quantity, unitPriceMinor: l.unit_price_minor, modifiers: mods(l.modifiers),
        modifiersTotalMinor: l.modifiers_total_minor, lineTotalMinor: l.line_total_minor })),
      totals: {
        subtotalMinor: o.subtotal_minor, discountMinor: o.discount_minor, serviceChargeMinor: o.service_charge_minor, deliveryFeeMinor: o.delivery_fee_minor,
        taxMinor: o.tax_minor, taxInclusive: o.tax_inclusive, totalMinor: o.total_minor, paidMinor: o.paid_minor - o.refunded_minor,
        dueMinor: o.status === 'cancelled' ? 0 : Math.max(0, o.total_minor - (o.paid_minor - o.refunded_minor)),
      },
      payments: payments.map((p) => ({ method: p.method, provider: p.provider, amountMinor: Number(p.amount_minor), at: iso(p.created_at) })),
    };
  }
}
