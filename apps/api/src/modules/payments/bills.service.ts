import { Inject, Injectable } from '@nestjs/common';
import { planSplit, SplitRuleError, type BillUnit, type CreateSplit, type SplitView } from '@resuto/contracts';
import { ENV, type Env } from '../../config/env';
import type { TenantContext } from '../../common/auth/context';
import { newToken, sha256 } from '../../common/crypto/hash';
import { SecretBox } from '../../common/crypto/secret-box';
import { DbService, type Tx } from '../../common/db/db.service';
import { EntitlementsService } from '../../common/entitlements/entitlements.service';
import { DomainError, conflict, notFound } from '../../common/errors/domain-error';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { PaymentLedgerService } from '../kernel/payment-ledger.service';
import { CheckoutService } from './checkout.service';
import { ReceiptsService } from './receipts.service';
import { guestCtx, iso } from './util';

/** A table visit, or a counter visit (FT-07: no table, takeaway). */
interface GuestVisit { visitId: string; orgId: string; branchId: string; tableId: string | null; kind: 'table' | 'counter' }

/**
 * QR table bill payment (MODULE_CONTRACTS §8 guest table session): view the
 * bill, pay it in full, or split it (whole / equal / custom / by item) into
 * shares that each have their own link `/s/<token>`.
 */
@Injectable()
export class BillsService {
  constructor(
    @Inject(ENV) private readonly env: Env,
    private readonly db: DbService,
    private readonly box: SecretBox,
    private readonly entitlements: EntitlementsService,
    private readonly idempotency: IdempotencyService,
    private readonly ledger: PaymentLedgerService,
    private readonly checkout: CheckoutService,
    private readonly receipts: ReceiptsService,
  ) {}

  /** X-Visit-Token → open visit (sha256 match on visits.guest_token_hash). */
  async resolveVisit(token: string | undefined): Promise<GuestVisit> {
    if (!token || token.length < 16 || token.length > 200) throw new DomainError('visit_token_required', 'Scan the table QR code to open your bill', 401);
    const v = await this.db.withPlatform((tx) => tx.maybeOne<any>(
      `select id, org_id, branch_id, table_id, kind from visits where guest_token_hash = $1 and status = 'open'`, [sha256(token)]));
    if (!v) throw notFound('Table session');
    await this.entitlements.assert(v.org_id, 'pay');
    return { visitId: v.id, orgId: v.org_id, branchId: v.branch_id, tableId: v.table_id, kind: v.kind === 'counter' ? 'counter' : 'table' };
  }

  private shareUrl(token: string) {
    return `${this.env.APP_ORIGIN.replace(/\/$/, '')}/s/${token}`;
  }

  /**
   * Applies unused reservation-deposit credit to the bill as a `deposit_credit`
   * ledger payment. The ledger consumes `visits.credit_used_minor` atomically, so
   * credit can never be applied twice (here, at close, or concurrently).
   */
  async applyCredit(tx: Tx, ctx: TenantContext, visitId: string) {
    const v = await tx.one<any>('select branch_id, credit_minor, credit_used_minor from visits where id = $1 for update', [visitId]);
    const available = Number(v.credit_minor) - Number(v.credit_used_minor);
    if (available < 1) return 0;
    const due = (await this.ledger.outstanding(tx, { visitId })).dueMinor;
    const pending = await tx.one<{ s: number }>(`select coalesce(sum(amount_minor), 0)::bigint as s from payments where visit_id = $1 and status in ('pending', 'requires_action', 'authorized')`, [visitId]);
    const amount = Math.min(available, due - Number(pending.s));
    if (amount < 1) return 0;
    const currency = (await tx.one<any>('select currency from organizations where id = $1', [ctx.orgId])).currency;
    await this.ledger.recordSucceeded(tx, ctx, {
      branchId: v.branch_id, visitId, method: 'deposit_credit', provider: 'manual', amountMinor: amount, currency,
      idempotencyKey: `deposit-credit:${visitId}:${Number(v.credit_used_minor)}`, raw: { source: 'reservation_deposit_credit' },
    });
    return amount;
  }

  // ---------------------------------------------------------------------------
  async bill(token: string | undefined) {
    const g = await this.resolveVisit(token);
    return this.db.withTenant(g.orgId, (tx) => this.billView(tx, g), `visit:${g.visitId}`);
  }

  private async billView(tx: Tx, g: GuestVisit) {
    const org = await tx.one<any>('select name, name_ar, currency from organizations where id = $1', [g.orgId]);
    const table = g.tableId ? await tx.one<any>('select label from dining_tables where id = $1', [g.tableId]) : null;
    const visit = await tx.one<any>('select credit_minor from visits where id = $1', [g.visitId]);
    const orders = await tx.query<any>(
      `select id, number, status, total_minor, paid_minor, refunded_minor, payment_status, placed_at from orders
        where visit_id = $1 and status <> 'cancelled' order by placed_at`, [g.visitId]);
    const lines = orders.length ? await tx.query<any>(
      `select id, order_id, name, name_ar, quantity, unit_price_minor + modifiers_total_minor as unit, line_total_minor, modifiers
         from order_lines where order_id = any($1::uuid[]) order by created_at, id`, [orders.map((o) => o.id)]) : [];
    const out = await this.ledger.outstanding(tx, { visitId: g.visitId });
    const usedCredit = await tx.one<{ s: number }>(
      `select coalesce(sum(amount_minor - refunded_minor), 0)::bigint as s from payments where visit_id = $1 and method = 'deposit_credit' and status in ('succeeded', 'partially_refunded')`, [g.visitId]);
    const unusedCredit = Math.max(0, Number(visit.credit_minor) - Number(usedCredit.s));
    const total = orders.reduce((s, o) => s + Number(o.total_minor), 0);
    const paid = orders.reduce((s, o) => s + Number(o.paid_minor) - Number(o.refunded_minor), 0);
    const pendingAttempt = await tx.maybeOne<any>(
      `select s.id, s.token_sealed, s.amount_minor, s.share_id from checkout_sessions s
        where s.visit_id = $1 and s.status = 'processing' and s.expires_at > now() order by s.created_at desc limit 1`, [g.visitId]);
    const receipts = await tx.query<any>(
      `select id, amount_minor, method, share_id, captured_at from payments where visit_id = $1 and status in ('succeeded', 'partially_refunded', 'refunded')
          and method <> 'deposit_credit' order by captured_at desc`, [g.visitId]);
    const byOrder = new Map<string, any[]>();
    for (const l of lines) byOrder.set(l.order_id, [...(byOrder.get(l.order_id) ?? []), l]);
    const methods = await this.checkout.methods(tx, g.orgId, g.branchId, 'visit_bill', g.kind === 'counter' ? 'pickup' : 'dine_in');
    const live = orders.filter((o) => o.status !== 'cancelled');
    return {
      visitId: g.visitId, currency: org.currency, org: { name: org.name, nameAr: org.name_ar }, table: table ? { label: table.label } : null,
      kind: g.kind, ticket: g.kind === 'counter' && live.length ? String(live[live.length - 1].number) : null,
      orders: orders.map((o) => ({
        id: o.id, number: o.number, status: o.status, paymentStatus: o.payment_status, totalMinor: Number(o.total_minor),
        dueMinor: out.orders.find((x) => x.id === o.id)?.dueMinor ?? 0,
        lines: (byOrder.get(o.id) ?? []).map((l) => ({ id: l.id, name: l.name, nameAr: l.name_ar, quantity: l.quantity, unitPriceMinor: Number(l.unit), lineTotalMinor: Number(l.line_total_minor) })),
      })),
      totals: { totalMinor: total, paidMinor: paid, creditMinor: unusedCredit, dueMinor: Math.max(0, out.dueMinor - unusedCredit) },
      split: await this.splitView(tx, g.orgId, { visitId: g.visitId }),
      pendingCheckout: pendingAttempt ? { url: this.checkout.linkFor(g.orgId, pendingAttempt.token_sealed), amountMinor: pendingAttempt.amount_minor, shareId: pendingAttempt.share_id } : null,
      receipts: receipts.map((r) => ({ paymentId: r.id, amountMinor: r.amount_minor, method: r.method, share: !!r.share_id, at: iso(r.captured_at) })),
      methods,
    };
  }

  /** Pay the whole remaining bill (or part of it) online. */
  async checkoutBill(token: string | undefined, body: { amountMinor?: number; key: string }) {
    const g = await this.resolveVisit(token);
    const gctx = guestCtx(g.orgId, `visit:${g.visitId}`);
    return this.db.withTenant(g.orgId, async (tx) => {
      const r = await this.idempotency.run(tx, g.orgId, `visit-checkout:${g.visitId}`, body.key, body, async () => {
        if (await tx.maybeOne(`select 1 from bill_splits where visit_id = $1 and status = 'open'`, [g.visitId])) {
          throw conflict('split_active', 'This bill is being split. Use your share link.');
        }
        await this.applyCredit(tx, gctx, g.visitId);
        const due = (await this.ledger.outstanding(tx, { visitId: g.visitId })).dueMinor;
        const amount = body.amountMinor ?? due;
        const reusable = await tx.maybeOne<any>(
          `select id from checkout_sessions where visit_id = $1 and purpose = 'visit_bill' and share_id is null and status = 'open'
              and amount_minor = $2 and expires_at > now() + interval '5 minutes' order by created_at desc limit 1`, [g.visitId, amount]);
        if (reusable) return { sessionId: reusable.id as string };
        const created = await this.checkout.createSession(tx, gctx, { purpose: 'visit_bill', visitId: g.visitId, amountMinor: amount, channel: 'qr' });
        return { sessionId: created.id };
      });
      return this.sessionLink(tx, g.orgId, r.sessionId);
    }, `visit:${g.visitId}`);
  }

  private async sessionLink(tx: Tx, orgId: string, sessionId: string) {
    const s = await tx.one<any>('select id, token_sealed, amount_minor, currency, expires_at from checkout_sessions where id = $1', [sessionId]);
    return { id: s.id, url: this.checkout.linkFor(orgId, s.token_sealed), amountMinor: s.amount_minor, currency: s.currency, expiresAt: iso(s.expires_at) };
  }

  // ---------------------------------------------------------------------------
  // Splits
  // ---------------------------------------------------------------------------
  async createSplit(token: string | undefined, body: CreateSplit) {
    const g = await this.resolveVisit(token);
    const gctx = guestCtx(g.orgId, `visit:${g.visitId}`);
    return this.db.withTenant(g.orgId, async (tx) => {
      await this.idempotency.run(tx, g.orgId, `visit-split:${g.visitId}`, body.key, body, async () => {
        await tx.one('select id from visits where id = $1 for update', [g.visitId]);
        const existing = await tx.maybeOne<{ id: string }>(`select id from bill_splits where visit_id = $1 and status = 'open'`, [g.visitId]);
        if (existing) return { splitId: existing.id };
        if (await tx.maybeOne(`select 1 from payments where visit_id = $1 and status in ('pending', 'requires_action', 'authorized')`, [g.visitId])) {
          throw conflict('checkout_pending', 'Finish the pending checkout first');
        }
        await this.applyCredit(tx, gctx, g.visitId);
        const due = (await this.ledger.outstanding(tx, { visitId: g.visitId })).dueMinor;
        const units = await this.units(tx, g.visitId);
        let plan;
        try {
          plan = planSplit(due, { mode: body.mode, people: body.people, amounts: body.amounts, allocations: body.allocations }, units);
        } catch (e) {
          if (e instanceof SplitRuleError) throw new DomainError(e.code, e.message, e.code === 'bill_settled' ? 409 : 422);
          throw e;
        }
        const currency = (await tx.one<any>('select currency from organizations where id = $1', [g.orgId])).currency;
        const split = await tx.one<{ id: string }>(
          `insert into bill_splits(org_id, branch_id, visit_id, mode, parts, total_minor, currency) values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [g.orgId, g.branchId, g.visitId, body.mode, plan.amounts.length, due, currency]);
        const byKey = new Map(units.map((u) => [`${u.lineId}:${u.unit}`, u]));
        for (let i = 0; i < plan.amounts.length; i++) {
          const shareToken = newToken();
          const label = (body.allocations?.[i]?.label || body.labels?.[i] || '').trim() || `Guest ${i + 1}`;
          const allocation = plan.allocations[i]!.map((a) => { const u = byKey.get(`${a.lineId}:${a.unit}`)!; return { lineId: a.lineId, unit: a.unit, name: u.name, amountMinor: u.amountMinor }; });
          await tx.query(
            `insert into bill_shares(org_id, split_id, label, amount_minor, line_ids, status, participant_token_hash, token_sealed, position, allocation)
             values ($1, $2, $3, $4, $5::uuid[], 'open', $6, $7, $8, $9)`,
            [g.orgId, split.id, label.slice(0, 60), plan.amounts[i], allocation.map((a) => a.lineId), sha256(shareToken),
              this.box.seal(shareToken, `share:${g.orgId}`), i, JSON.stringify(allocation)]);
        }
        // A full-bill link that is still open would bypass the shares.
        await tx.query(`update checkout_sessions set status = 'cancelled' where visit_id = $1 and share_id is null and status = 'open'`, [g.visitId]);
        return { splitId: split.id };
      });
      return this.splitView(tx, g.orgId, { visitId: g.visitId });
    }, `visit:${g.visitId}`);
  }

  async cancelSplit(token: string | undefined) {
    const g = await this.resolveVisit(token);
    return this.db.withTenant(g.orgId, async (tx) => {
      const split = await tx.maybeOne<any>(`select id from bill_splits where visit_id = $1 and status = 'open' for update`, [g.visitId]);
      if (!split) throw notFound('Split');
      const busy = await tx.maybeOne(
        `select 1 from bill_shares s where s.split_id = $1 and s.paid_minor > 0
         union all select 1 from payments p join bill_shares s on s.id = p.share_id where s.split_id = $1 and p.status in ('pending', 'requires_action', 'authorized') limit 1`, [split.id]);
      if (busy) throw conflict('split_has_payments', 'Someone already paid or is paying a share; the split cannot be cancelled');
      await tx.query(`update bill_splits set status = 'cancelled' where id = $1`, [split.id]);
      await tx.query(`update bill_shares set status = 'void' where split_id = $1`, [split.id]);
      await tx.query(`update checkout_sessions set status = 'cancelled' where share_id in (select id from bill_shares where split_id = $1) and status = 'open'`, [split.id]);
      return { cancelled: true };
    }, `visit:${g.visitId}`);
  }

  /** Every unit of every line of the visit's live orders (legacy key: line × unit index). */
  private async units(tx: Tx, visitId: string): Promise<BillUnit[]> {
    const lines = await tx.query<any>(
      `select l.id, l.name, l.quantity, l.line_total_minor from order_lines l join orders o on o.id = l.order_id
        where o.visit_id = $1 and o.status <> 'cancelled' order by l.created_at, l.id`, [visitId]);
    const out: BillUnit[] = [];
    for (const l of lines) {
      // line_total = (unit + modifiers) × qty, so the per-unit amount is exact.
      const each = Number(l.line_total_minor) / l.quantity;
      for (let u = 0; u < l.quantity; u++) out.push({ lineId: l.id, unit: u, amountMinor: each, name: l.name });
    }
    return out;
  }

  async splitView(tx: Tx, orgId: string, where: { visitId: string }): Promise<SplitView | null> {
    const split = await tx.maybeOne<any>(
      `select * from bill_splits where visit_id = $1 and status in ('open', 'settled') order by created_at desc limit 1`, [where.visitId]);
    if (!split) return null;
    const shares = await tx.query<any>('select * from bill_shares where split_id = $1 order by position, created_at', [split.id]);
    return {
      id: split.id, mode: split.mode, totalMinor: Number(split.total_minor), currency: split.currency, status: split.status, createdAt: iso(split.created_at)!,
      shares: shares.map((s) => ({
        id: s.id, label: s.label, amountMinor: Number(s.amount_minor), paidMinor: Number(s.paid_minor), status: s.status,
        url: this.shareLink(orgId, s.token_sealed) ?? '', items: Array.isArray(s.allocation) ? s.allocation : [],
      })),
    };
  }

  private shareLink(orgId: string, sealed: string | null) {
    if (!sealed) return null;
    try {
      return this.shareUrl(this.box.open(sealed, `share:${orgId}`));
    } catch {
      return null;
    }
  }

  async visitReceipt(token: string | undefined, paymentId: string) {
    const g = await this.resolveVisit(token);
    return this.db.withTenant(g.orgId, async (tx) => {
      const p = await tx.maybeOne('select id from payments where id = $1 and visit_id = $2', [paymentId, g.visitId]);
      if (!p) throw notFound('Receipt');
      return this.receipts.build(tx, paymentId);
    }, `visit:${g.visitId}`);
  }

  // ---------------------------------------------------------------------------
  // Shares (/s/<token>) — the share link is the bearer credential
  // ---------------------------------------------------------------------------
  private async resolveShare(token: string) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 200) throw notFound('Payment invitation');
    const s = await this.db.withPlatform((tx) => tx.maybeOne<any>('select id, org_id from bill_shares where participant_token_hash = $1', [sha256(token)]));
    if (!s) throw notFound('Payment invitation');
    await this.entitlements.assert(s.org_id, 'pay');
    return { shareId: s.id as string, orgId: s.org_id as string };
  }

  async shareView(token: string) {
    const { shareId, orgId } = await this.resolveShare(token);
    return this.db.withTenant(orgId, async (tx) => {
      const s = await tx.one<any>(
        `select s.*, sp.status as split_status, sp.mode, sp.visit_id, sp.currency, sp.branch_id, v.status as visit_status
           from bill_shares s join bill_splits sp on sp.id = s.split_id left join visits v on v.id = sp.visit_id where s.id = $1`, [shareId]);
      const org = await tx.one<any>('select name, name_ar from organizations where id = $1', [orgId]);
      const branch = await tx.one<any>('select name, name_ar from branches where id = $1', [s.branch_id]);
      const counts = await tx.one<any>(`select count(*)::int as n, count(*) filter (where status = 'paid')::int as paid from bill_shares where split_id = $1 and status <> 'void'`, [s.split_id]);
      const open = await tx.maybeOne<any>(
        `select token_sealed from checkout_sessions where share_id = $1 and status in ('open', 'processing') and expires_at > now() order by created_at desc limit 1`, [shareId]);
      const receipt = await tx.maybeOne<any>(`select id from payments where share_id = $1 and status in ('succeeded', 'partially_refunded', 'refunded') order by captured_at desc limit 1`, [shareId]);
      const remaining = s.visit_id ? (await this.ledger.outstanding(tx, { visitId: s.visit_id })).dueMinor : 0;
      return {
        id: s.id, label: s.label, payerName: s.payer_name, amountMinor: Number(s.amount_minor), paidMinor: Number(s.paid_minor), currency: s.currency,
        status: s.split_status === 'cancelled' ? 'void' : s.status, mode: s.mode, items: Array.isArray(s.allocation) ? s.allocation : [],
        restaurant: { name: org.name, nameAr: org.name_ar }, branch: { name: branch.name, nameAr: branch.name_ar },
        participants: counts.n, paidCount: counts.paid, remainingBillMinor: remaining, visitOpen: s.visit_status === 'open',
        checkoutUrl: open ? this.checkout.linkFor(orgId, open.token_sealed) : null, receiptPaymentId: receipt?.id ?? null,
      };
    }, `share:${shareId}`);
  }

  async shareCheckout(token: string, body: { payerName?: string | null; key: string }) {
    const { shareId, orgId } = await this.resolveShare(token);
    const gctx = guestCtx(orgId, `share:${shareId}`);
    return this.db.withTenant(orgId, async (tx) => {
      const r = await this.idempotency.run(tx, orgId, `share-checkout:${shareId}`, body.key, body, async () => {
        const s = await tx.one<any>(
          `select s.*, sp.status as split_status, v.status as visit_status from bill_shares s join bill_splits sp on sp.id = s.split_id
             left join visits v on v.id = sp.visit_id where s.id = $1 for update of s`, [shareId]);
        if (s.status === 'paid') throw conflict('share_paid', 'This share is already paid');
        if (s.status !== 'open' || s.split_status !== 'open') throw new DomainError('share_inactive', 'This payment invitation is no longer active', 410);
        if (s.visit_status && s.visit_status !== 'open') throw conflict('visit_closed', 'This table session has ended');
        if (body.payerName) await tx.query('update bill_shares set payer_name = $2 where id = $1', [shareId, body.payerName.trim().slice(0, 60)]);
        const reusable = await tx.maybeOne<any>(
          `select id from checkout_sessions where share_id = $1 and status in ('open', 'processing') and expires_at > now() + interval '5 minutes' order by created_at desc limit 1`, [shareId]);
        if (reusable) return { sessionId: reusable.id as string };
        const created = await this.checkout.createSession(tx, gctx, { purpose: 'bill_share', shareId, channel: 'qr' });
        return { sessionId: created.id };
      });
      return this.sessionLink(tx, orgId, r.sessionId);
    }, `share:${shareId}`);
  }

  async shareReceipt(token: string) {
    const { shareId, orgId } = await this.resolveShare(token);
    return this.db.withTenant(orgId, async (tx) => {
      const p = await tx.maybeOne<any>(`select id from payments where share_id = $1 and status in ('succeeded', 'partially_refunded', 'refunded') order by captured_at desc limit 1`, [shareId]);
      if (!p) throw notFound('Receipt');
      return this.receipts.build(tx, p.id);
    }, `share:${shareId}`);
  }

  // ---------------------------------------------------------------------------
  // Reservation deposits
  // ---------------------------------------------------------------------------
  async reservationCheckout(code: string, accessToken: string) {
    if (!/^[A-Za-z0-9]{4,32}$/.test(code)) throw notFound('Reservation');
    const r = await this.db.withPlatform((tx) => tx.maybeOne<any>(
      `select id, org_id from reservations where code = $1 and access_token_hash = $2`, [code.toUpperCase(), sha256(accessToken)]));
    if (!r) throw notFound('Reservation');
    await this.entitlements.assert(r.org_id, 'pay');
    const gctx = guestCtx(r.org_id, `reservation:${r.id}`);
    return this.db.withTenant(r.org_id, async (tx) => {
      await tx.one('select id from reservations where id = $1 for update', [r.id]);
      const reusable = await tx.maybeOne<any>(
        `select id from checkout_sessions where reservation_id = $1 and purpose = 'reservation_deposit' and status in ('open', 'processing') and expires_at > now()
          order by created_at desc limit 1`, [r.id]);
      const id = reusable?.id ?? (await this.checkout.createSession(tx, gctx, { purpose: 'reservation_deposit', reservationId: r.id, channel: 'web' })).id;
      return this.sessionLink(tx, r.org_id, id);
    }, `reservation:${r.id}`);
  }
}
