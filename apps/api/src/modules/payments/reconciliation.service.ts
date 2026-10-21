import { Injectable } from '@nestjs/common';
import { parseMajor, type CashCountInput, type Currency, type ReconciliationRunInput } from '@resuto/contracts';
import { paymentAdapter, type ProviderTransaction } from '@resuto/integrations';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { branchScope, cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { PaymentProvidersService } from './providers.service';
import { iso, SETTLED } from './util';

type ItemStatus = 'matched' | 'missing_in_provider' | 'missing_in_resuto' | 'amount_mismatch' | 'status_mismatch';
interface Item { paymentId: string | null; providerTxnId: string | null; expected: number | null; actual: number | null; fee: number | null; status: ItemStatus; notes: string | null; dimension?: Record<string, unknown> }

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/**
 * Settlement statement → provider transactions. Header names (case-insensitive):
 * transaction_id (or id), amount (major units, e.g. 145.50) or amount_minor,
 * currency, status (succeeded/paid/success → succeeded; refunded; failed),
 * fee or fee_minor, refunded or refunded_minor, reference, created_at.
 */
export function statementToTransactions(csv: string, currency: Currency): ProviderTransaction[] {
  const [header, ...rows] = parseCsv(csv.replace(/^﻿/, ''));
  if (!header) throw invalid('invalid_statement', 'The settlement file is empty');
  const h = header.map((c) => c.trim().toLowerCase());
  const col = (...names: string[]) => names.map((n) => h.indexOf(n)).find((i) => i >= 0) ?? -1;
  const idI = col('transaction_id', 'id', 'txn_id'), amtI = col('amount'), amtMinorI = col('amount_minor', 'amount_cents'), curI = col('currency');
  const stI = col('status'), feeI = col('fee'), feeMinorI = col('fee_minor'), refI = col('refunded'), refMinorI = col('refunded_minor'), refnI = col('reference'), atI = col('created_at', 'date');
  if (idI < 0 || (amtI < 0 && amtMinorI < 0)) throw invalid('invalid_statement', 'The file needs transaction_id and amount (or amount_minor) columns');
  if (rows.length > 20_000) throw invalid('invalid_statement', 'At most 20,000 rows per upload');
  const money = (minorIdx: number, majorIdx: number, r: string[], cur: Currency) => {
    if (minorIdx >= 0 && r[minorIdx]?.trim()) { const n = Number(r[minorIdx]!.trim()); if (!Number.isSafeInteger(n)) throw new RangeError('bad minor amount'); return n; }
    if (majorIdx >= 0 && r[majorIdx]?.trim()) return parseMajor(r[majorIdx]!.trim().replace(/,/g, ''), cur);
    return null;
  };
  return rows.map((r, i) => {
    try {
      const cur = ((curI >= 0 && r[curI]?.trim().toUpperCase()) || currency) as Currency;
      const amount = money(amtMinorI, amtI, r, cur);
      if (!r[idI]?.trim() || amount === null) throw new Error('missing id or amount');
      const raw = (stI >= 0 ? r[stI] ?? '' : 'succeeded').trim().toLowerCase();
      const refunded = money(refMinorI, refI, r, cur) ?? 0;
      const status: ProviderTransaction['status'] = ['refunded', 'refund'].includes(raw) ? (refunded && refunded < amount ? 'partially_refunded' : 'refunded')
        : ['failed', 'declined', 'error', 'voided'].includes(raw) ? 'failed' : ['pending', 'processing'].includes(raw) ? 'pending'
          : refunded > 0 ? (refunded >= amount ? 'refunded' : 'partially_refunded') : 'succeeded';
      return { providerPaymentId: r[idI]!.trim(), reference: refnI >= 0 ? r[refnI]?.trim() || null : null, amountMinor: amount, currency: cur, status,
        feeMinor: money(feeMinorI, feeI, r, cur), refundedMinor: refunded, createdAt: atI >= 0 && r[atI] ? new Date(r[atI]!).toISOString() : new Date(0).toISOString() };
    } catch (e) {
      throw invalid('invalid_statement', `Row ${i + 2}: ${(e as Error).message}`);
    }
  });
}

/** Provider/statement reconciliation and cash counts. */
@Injectable()
export class ReconciliationService {
  constructor(private readonly db: DbService, private readonly providers: PaymentProvidersService, private readonly audit: AuditService) {}

  async runProvider(ctx: TenantContext, input: ReconciliationRunInput) {
    if (input.branchId) ctx.assertBranch(input.branchId);
    const from = new Date(input.from), to = new Date(input.to);
    const currency = await this.db.scoped(ctx, async (tx) => (await tx.one<any>('select currency from organizations where id = $1', [ctx.orgId])).currency as Currency);
    let txns: ProviderTransaction[];
    let source: 'provider_api' | 'statement_upload' | 'sandbox' = input.source;
    if (input.source === 'statement_upload') {
      txns = statementToTransactions(input.csv!, currency);
    } else {
      const adapter = paymentAdapter(input.provider);
      if (!adapter) throw invalid('unknown_provider', 'This provider cannot be reconciled through its API; upload a settlement file');
      let connectionId: string | null = null;
      if (input.provider === 'simulated') {
        if (this.providers.mode !== 'sandbox') throw new DomainError('sandbox_disabled', 'Simulated payments are disabled in live mode', 403);
        source = 'sandbox';
      } else {
        const conn = await this.db.scoped(ctx, (tx) => tx.maybeOne<{ id: string }>(
          `select id from integration_connections where org_id = $1 and category = 'payments' and provider = $2 and status in ('connected', 'sandbox') and enabled
              and ($3::uuid is null or branch_id is null or branch_id = $3) order by (branch_id is not null) desc limit 1`, [ctx.orgId, input.provider, input.branchId ?? null]));
        if (!conn) throw conflict('not_connected', `Connect ${input.provider} first, or upload a settlement file`);
        connectionId = conn.id;
      }
      try {
        txns = await adapter.listTransactions(await this.providers.adapterContext(ctx.orgId, { provider: input.provider, connectionId }), { from, to });
      } catch (error) {
        throw new DomainError('provider_unavailable', `Could not list ${input.provider} transactions: ${(error as Error).message}`.slice(0, 300), 502);
      }
    }
    return this.db.scoped(ctx, async (tx) => {
      const payments = await tx.query<any>(
        `select id, amount_minor, refunded_minor, status, provider_payment_id, fee_minor, currency from payments
          where org_id = $1 and provider = $2 and ($3::uuid is null or branch_id = $3)
            and coalesce(captured_at, created_at) >= $4 and coalesce(captured_at, created_at) < $5
            and (status in ('succeeded', 'partially_refunded', 'refunded') or provider_payment_id is not null)`,
        [ctx.orgId, input.provider, input.branchId ?? null, from, to]);
      const items = this.match(payments, txns);
      const run = await this.saveRun(tx, ctx, { provider: input.provider, branchId: input.branchId ?? null, from, to, source }, items,
        { providerTransactions: txns.length, resutoPayments: payments.length });
      await this.audit.record(tx, ctx, { action: 'reconciliation.completed', entityType: 'reconciliation_run', entityId: run.id, branchId: input.branchId ?? null,
        metadata: { provider: input.provider, source, totals: run.totals } });
      return run;
    });
  }

  match(payments: any[], txns: ProviderTransaction[]): Item[] {
    const byProviderId = new Map(txns.map((t) => [t.providerPaymentId, t]));
    const byRef = new Map(txns.filter((t) => t.reference).map((t) => [t.reference!, t]));
    const used = new Set<ProviderTransaction>();
    const items: Item[] = [];
    for (const p of payments) {
      const t = (p.provider_payment_id && byProviderId.get(p.provider_payment_id)) || byRef.get(p.id);
      const settled = SETTLED.includes(p.status);
      if (!t) {
        if (settled) items.push({ paymentId: p.id, providerTxnId: p.provider_payment_id, expected: p.amount_minor, actual: null, fee: null, status: 'missing_in_provider', notes: 'Resuto recorded this payment; the provider has no matching transaction' });
        continue;
      }
      used.add(t);
      const providerSettled = ['succeeded', 'refunded', 'partially_refunded'].includes(t.status);
      let status: ItemStatus = 'matched';
      let notes: string | null = null;
      // PAY-21: the same number in another currency is not the same amount.
      if (p.currency && t.currency && String(t.currency).toUpperCase() !== String(p.currency).toUpperCase()) {
        status = 'amount_mismatch'; notes = `Currency: Resuto ${p.currency}, provider ${t.currency}`;
      } else if (t.amountMinor !== p.amount_minor) { status = 'amount_mismatch'; notes = `Resuto ${p.amount_minor}, provider ${t.amountMinor}`; }
      else if (settled !== providerSettled) { status = 'status_mismatch'; notes = `Resuto ${p.status}, provider ${t.status}`; }
      else if (settled && t.refundedMinor !== Number(p.refunded_minor)) { status = 'status_mismatch'; notes = `Refunded: Resuto ${p.refunded_minor}, provider ${t.refundedMinor}`; }
      items.push({ paymentId: p.id, providerTxnId: t.providerPaymentId, expected: p.amount_minor, actual: t.amountMinor, fee: t.feeMinor, status, notes });
    }
    for (const t of txns) {
      if (used.has(t) || !['succeeded', 'refunded', 'partially_refunded'].includes(t.status)) continue;
      items.push({ paymentId: null, providerTxnId: t.providerPaymentId, expected: null, actual: t.amountMinor, fee: t.feeMinor, status: 'missing_in_resuto', notes: 'The provider settled a transaction Resuto has no settled payment for' });
    }
    return items;
  }

  private async saveRun(tx: Tx, ctx: TenantContext, run: { provider: string; branchId: string | null; from: Date; to: Date; source: string }, items: Item[], extra: Record<string, unknown>) {
    const count = (s: ItemStatus) => items.filter((i) => i.status === s).length;
    const sumOf = (k: 'expected' | 'actual' | 'fee', f: (i: Item) => boolean = () => true) => items.filter(f).reduce((s, i) => s + (i[k] ?? 0), 0);
    const totals = {
      items: items.length, matched: count('matched'), missingInProvider: count('missing_in_provider'), missingInResuto: count('missing_in_resuto'),
      amountMismatch: count('amount_mismatch'), statusMismatch: count('status_mismatch'),
      expectedMinor: sumOf('expected'), actualMinor: sumOf('actual'), feesMinor: sumOf('fee'),
      differenceMinor: sumOf('actual') - sumOf('expected'), ...extra,
    };
    const row = await tx.one<any>(
      `insert into reconciliation_runs(org_id, branch_id, provider, period_start, period_end, status, source, totals, created_by, completed_at)
       values ($1, $2, $3, $4, $5, 'completed', $6, $7, $8, now()) returning *`,
      [ctx.orgId, run.branchId, run.provider, run.from, run.to, run.source, totals, ctx.userId]);
    for (const i of items) {
      await tx.query(
        `insert into reconciliation_items(org_id, run_id, payment_id, provider_txn_id, expected_minor, actual_minor, fee_minor, status, resolution, notes, dimension)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [ctx.orgId, row.id, i.paymentId, i.providerTxnId, i.expected, i.actual, i.fee, i.status, i.status === 'matched' ? null : 'open', i.notes, i.dimension ?? {}]);
    }
    return this.toRun(row);
  }

  private toRun(r: any) {
    return { id: r.id, branchId: r.branch_id, provider: r.provider, periodStart: iso(r.period_start), periodEnd: iso(r.period_end), status: r.status,
      source: r.source, totals: r.totals, createdBy: r.created_by, createdAt: iso(r.created_at), completedAt: iso(r.completed_at) };
  }

  async listRuns(ctx: TenantContext, q: { limit: number; cursor?: string } = { limit: 50 }) {
    const k = keyset(q.cursor);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select *, ${cursorAt('created_at')} as cursor_at from reconciliation_runs where org_id = $1 and ${branchScope('branch_id', 2)} ${k.after('created_at', 'id', 3)}
          order by created_at desc, id desc limit ${k.fetch(q.limit)}`, [ctx.orgId, ctx.branchFilter, ...k.params]);
      return pageOf(rows, q.limit, (r) => ({ at: r.cursor_at, id: r.id }), (r) => this.toRun(r));
    });
  }

  async getRun(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne<any>('select * from reconciliation_runs where id = $1', [id]);
      if (!r) throw notFound('Reconciliation run');
      const items = await tx.query<any>('select * from reconciliation_items where run_id = $1 order by (status = \'matched\'), created_at', [id]);
      return { ...this.toRun(r), items: items.map((i) => ({ id: i.id, paymentId: i.payment_id, providerTxnId: i.provider_txn_id, expectedMinor: i.expected_minor,
        actualMinor: i.actual_minor, feeMinor: i.fee_minor, status: i.status, resolution: i.resolution, notes: i.notes, dimension: i.dimension })) };
    });
  }

  async resolveItem(ctx: TenantContext, itemId: string, body: { resolution: string; notes?: string | null }) {
    return this.db.scoped(ctx, async (tx) => {
      const i = await tx.maybeOne<any>(
        `update reconciliation_items set resolution = $2, notes = coalesce($3, notes) where id = $1 and status <> 'matched' returning id, run_id`, [itemId, body.resolution, body.notes ?? null]);
      if (!i) throw notFound('Reconciliation item');
      await this.audit.record(tx, ctx, { action: 'reconciliation.item_resolved', entityType: 'reconciliation_item', entityId: itemId, metadata: { resolution: body.resolution } });
      return { id: itemId, resolution: body.resolution };
    });
  }

  // ---------------------------------------------------------------------------
  // Cash
  // ---------------------------------------------------------------------------
  async expectedCash(ctx: TenantContext, q: { branchId: string; from: string; to: string }) {
    ctx.assertBranch(q.branchId);
    return this.db.scoped(ctx, (tx) => this.cashGroups(tx, ctx.orgId, q));
  }

  private async cashGroups(tx: Tx, orgId: string, q: { branchId: string; from: string; to: string }) {
    const rows = await tx.query<any>(
      `select p.method::text as method, p.received_by, p.driver_id, sum(p.amount_minor - p.refunded_minor)::bigint as expected, count(*)::int as n,
              max(pr.full_name) as staff_name, max(d.display_name) as driver_name
         from payments p left join profiles pr on pr.id = p.received_by left join drivers d on d.id = p.driver_id
        where p.org_id = $1 and p.branch_id = $2 and p.method in ('cash', 'cod') and p.status in ('succeeded', 'partially_refunded', 'refunded')
          and coalesce(p.captured_at, p.created_at) >= $3 and coalesce(p.captured_at, p.created_at) < $4
        group by 1, 2, 3 order by 1, 2, 3`, [orgId, q.branchId, new Date(q.from), new Date(q.to)]);
    return {
      branchId: q.branchId, from: q.from, to: q.to,
      groups: rows.map((r) => ({ method: r.method, staffId: r.received_by, staffName: r.staff_name, driverId: r.driver_id, driverName: r.driver_name, expectedMinor: Number(r.expected), payments: r.n })),
      totalExpectedMinor: rows.reduce((s, r) => s + Number(r.expected), 0),
    };
  }

  async cashCount(ctx: TenantContext, input: CashCountInput) {
    ctx.assertBranch(input.branchId);
    return this.db.scoped(ctx, async (tx) => {
      const expected = await this.cashGroups(tx, ctx.orgId, input);
      const key = (g: { method: string; staffId?: string | null; driverId?: string | null }) => `${g.method}|${g.staffId ?? ''}|${g.driverId ?? ''}`;
      const counted = new Map<string, number>();
      for (const c of input.counts) counted.set(key(c), (counted.get(key(c)) ?? 0) + c.countedMinor);
      const items: Item[] = [];
      const seen = new Set<string>();
      for (const g of expected.groups) {
        const k = key(g);
        seen.add(k);
        const actual = counted.has(k) ? counted.get(k)! : null;
        items.push({ paymentId: null, providerTxnId: null, expected: g.expectedMinor, actual, fee: null,
          status: actual === g.expectedMinor ? 'matched' : 'amount_mismatch', notes: actual === null ? 'Not counted' : actual === g.expectedMinor ? null : `Difference ${actual - g.expectedMinor}`,
          dimension: { method: g.method, staffId: g.staffId, staffName: g.staffName, driverId: g.driverId, driverName: g.driverName } });
      }
      for (const c of input.counts) {
        const k = key(c);
        if (seen.has(k)) continue;
        seen.add(k);
        items.push({ paymentId: null, providerTxnId: null, expected: 0, actual: counted.get(k)!, fee: null, status: counted.get(k) === 0 ? 'matched' : 'amount_mismatch',
          notes: 'Counted but no recorded cash payments', dimension: { method: c.method, staffId: c.staffId ?? null, driverId: c.driverId ?? null } });
      }
      const run = await this.saveRun(tx, ctx, { provider: 'cash', branchId: input.branchId, from: new Date(input.from), to: new Date(input.to), source: 'cash_count' }, items,
        { note: input.note ?? null });
      await this.audit.record(tx, ctx, { action: 'reconciliation.cash_counted', entityType: 'reconciliation_run', entityId: run.id, branchId: input.branchId, metadata: { totals: run.totals } });
      return run;
    });
  }
}
