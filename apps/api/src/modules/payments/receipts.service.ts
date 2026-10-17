import { Injectable } from '@nestjs/common';
import type { ReceiptView } from '@resuto/contracts';
import type { Tx } from '../../common/db/db.service';
import { notFound } from '../../common/errors/domain-error';
import { SETTLED } from './util';

const ref = (prefix: string, value: string) => `${prefix}-${value.replace(/[^a-z0-9]/gi, '').slice(0, 8).toUpperCase()}`;

/**
 * Digital receipts (legacy receipts.js): ALWAYS derived from a settled payment
 * row. Nothing here can create or imply a payment; no settled payment → no receipt.
 */
@Injectable()
export class ReceiptsService {
  async build(tx: Tx, paymentId: string): Promise<ReceiptView> {
    const p = await tx.maybeOne<any>('select * from payments where id = $1', [paymentId]);
    if (!p || !SETTLED.includes(p.status)) throw notFound('Receipt');
    const org = await tx.one<any>('select name, name_ar from organizations where id = $1', [p.org_id]);
    const branch = await tx.maybeOne<any>('select name, name_ar from branches where id = $1', [p.branch_id]);
    const base = {
      id: ref('RC', p.id), paymentId: p.id, status: p.status === 'succeeded' ? 'paid' : p.status, at: new Date(p.captured_at ?? p.created_at).toISOString(),
      currency: p.currency, restaurant: { name: org.name, nameAr: org.name_ar }, branch: branch ? { name: branch.name, nameAr: branch.name_ar } : null,
      amountMinor: p.amount_minor, refundedMinor: p.refunded_minor,
      payment: { provider: p.provider, method: p.method, mode: p.is_test || p.provider === 'simulated' ? 'test' : 'live', transactionId: ref('TXN', p.provider_payment_id ?? p.id) },
    } as const;

    if (p.reservation_id && !p.order_id && !p.visit_id) {
      const r = await tx.one<any>('select code, starts_at, party_size, guest_name from reservations where id = $1', [p.reservation_id]);
      return {
        ...base, kind: 'deposit', reference: { orders: [], reservation: `RSV-${r.code}` }, table: null, items: [],
        totals: { subtotalMinor: p.amount_minor, discountMinor: 0, feeMinor: 0, taxMinor: 0, totalMinor: p.amount_minor, paidMinor: p.amount_minor, dueMinor: 0, creditMinor: 0 },
        split: null, reservation: { code: r.code, startsAt: new Date(r.starts_at).toISOString(), partySize: r.party_size, guestName: r.guest_name },
      } as ReceiptView;
    }

    const orders = await tx.query<any>(
      p.visit_id
        ? `select * from orders where visit_id = $1 and status <> 'cancelled' order by placed_at`
        : `select * from orders where id = $1`, [p.visit_id ?? p.order_id]);
    const ids = orders.map((o) => o.id);
    const lines = ids.length ? await tx.query<any>(
      `select name, name_ar, unit_price_minor + modifiers_total_minor as unit, sum(quantity)::int as qty, sum(line_total_minor)::bigint as total
         from order_lines where order_id = any($1::uuid[]) group by name, name_ar, unit_price_minor + modifiers_total_minor order by min(created_at)`, [ids]) : [];
    const sumOf = (k: string) => orders.reduce((s, o) => s + Number(o[k]), 0);
    const total = sumOf('total_minor');
    const paid = sumOf('paid_minor') - sumOf('refunded_minor');
    const credit = p.visit_id ? Number((await tx.one<any>('select credit_minor from visits where id = $1', [p.visit_id])).credit_minor) : 0;
    const tableRow = orders[0]?.table_id ? await tx.maybeOne<any>('select label from dining_tables where id = $1', [orders[0].table_id]) : null;
    let split: ReceiptView['split'] = null;
    if (p.share_id) {
      const s = await tx.one<any>(
        `select s.amount_minor, s.label, sp.mode, (select count(*)::int from bill_shares x where x.split_id = s.split_id and x.status <> 'void') as n,
                (select count(*)::int from bill_shares x where x.split_id = s.split_id and x.status = 'paid') as paid
           from bill_shares s join bill_splits sp on sp.id = s.split_id where s.id = $1`, [p.share_id]);
      split = { yourShareMinor: s.amount_minor, participants: s.n, paidCount: s.paid, mode: s.mode, label: s.label };
    }
    return {
      ...base,
      kind: p.share_id ? 'share' : p.visit_id ? 'bill' : 'order',
      reference: { orders: orders.map((o) => `RS-${String(o.number).padStart(5, '0')}`) },
      table: tableRow?.label ?? null,
      items: lines.map((l) => ({ name: l.name, nameAr: l.name_ar, unitPriceMinor: Number(l.unit), quantity: l.qty, totalMinor: Number(l.total) })),
      totals: {
        subtotalMinor: sumOf('subtotal_minor'), discountMinor: sumOf('discount_minor'), feeMinor: sumOf('delivery_fee_minor') + sumOf('service_charge_minor'),
        taxMinor: sumOf('tax_minor'), totalMinor: total, paidMinor: paid, dueMinor: Math.max(0, total - paid), creditMinor: credit,
      },
      split,
      reservation: null,
    } as ReceiptView;
  }
}
