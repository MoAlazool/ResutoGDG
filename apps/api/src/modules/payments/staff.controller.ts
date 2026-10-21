import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  cashCountInput, collectPayment, listQueryOf, createPaymentLink, createRefund, isoDateTime, listPaymentsQuery, reconciliationRunInput, resolveReconciliationItem, uuid,
} from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { invalid, notFound } from '../../common/errors/domain-error';
import { zod } from '../../common/http/zod.pipe';
import { PaymentLedgerService } from '../kernel/payment-ledger.service';
import { ReconciliationService } from './reconciliation.service';
import { RefundsService } from './refunds.service';
import { StaffPaymentsService } from './staff-payments.service';

const cashQuery = z.object({ branchId: uuid, from: isoDateTime, to: isoDateTime });
const dueQuery = z.object({ orderId: uuid.optional(), visitId: uuid.optional() }).refine((q) => !!(q.orderId || q.visitId), 'orderId or visitId is required');
const alertRefund = z.object({ key: z.string().min(8).max(120) });
const listQuery = listQueryOf({ defaultLimit: 50 }).extend({ status: z.string().max(40).optional() });
const alertsQuery = listQueryOf({ defaultLimit: 200 }).extend({ status: z.enum(['open', 'resolved', 'all']).default('open') });
const runsQuery = listQueryOf({ defaultLimit: 50 });
/** Manual refund completion: an optional staff note (PS-21: the body was not validated). */
const completeRefundInput = z.object({ note: z.string().trim().max(300).optional().nullable() }).strict();

/** Staff ResutoPay endpoints (paid module `pay`). */
@Controller('o/:orgId/payments')
@RequiresModule('pay')
export class PaymentsStaffController {
  constructor(
    private readonly payments: StaffPaymentsService,
    private readonly reconciliation: ReconciliationService,
    private readonly ledger: PaymentLedgerService,
    private readonly db: DbService,
    private readonly refundsSvc: RefundsService,
  ) {}

  @Get()
  @RequirePermission('payments:read')
  list(@Tenant() ctx: TenantContext, @Query(zod(listPaymentsQuery)) q: z.infer<typeof listPaymentsQuery>) {
    return this.payments.list(ctx, q);
  }

  @Get('config')
  @RequirePermission('payments:read')
  config(@Tenant() ctx: TenantContext, @Query('branchId', ParseUUIDPipe) branchId: string) {
    return this.payments.config(ctx, branchId);
  }

  /** What is still due for an order or a table bill (collect screen). */
  @Get('due')
  @RequirePermission('payments:collect')
  due(@Tenant() ctx: TenantContext, @Query(zod(dueQuery)) q: z.infer<typeof dueQuery>) {
    return this.db.scoped(ctx, async (tx) => {
      const row = q.orderId
        ? await tx.maybeOne<any>('select branch_id, currency from orders where id = $1', [q.orderId])
        : await tx.maybeOne<any>(`select v.branch_id, o.currency from visits v join organizations o on o.id = v.org_id where v.id = $1`, [q.visitId]);
      if (!row) throw notFound(q.orderId ? 'Order' : 'Table bill');
      ctx.assertBranch(row.branch_id);
      const out = await this.ledger.outstanding(tx, q);
      return { ...out, currency: row.currency };
    });
  }

  @Post('collect')
  @RequirePermission('payments:collect')
  collect(@Tenant() ctx: TenantContext, @Body(zod(collectPayment)) body: z.infer<typeof collectPayment>) {
    return this.payments.collect(ctx, body);
  }

  // --- payment links -----------------------------------------------------------
  @Get('links')
  @RequirePermission('payments:read')
  links(@Tenant() ctx: TenantContext, @Query(zod(listQuery)) q: z.infer<typeof listQuery>) {
    return this.payments.listLinks(ctx, q);
  }

  @Post('links')
  @RequirePermission('payments:collect')
  createLink(@Tenant() ctx: TenantContext, @Body(zod(createPaymentLink)) body: z.infer<typeof createPaymentLink>) {
    return this.payments.createLink(ctx, body);
  }

  @Post('links/:linkId/cancel')
  @RequirePermission('payments:collect')
  cancelLink(@Tenant() ctx: TenantContext, @Param('linkId', ParseUUIDPipe) id: string) {
    return this.payments.cancelLink(ctx, id);
  }

  // --- refunds -----------------------------------------------------------------
  @Get('refunds')
  @RequirePermission('payments:read')
  refunds(@Tenant() ctx: TenantContext, @Query(zod(listQuery)) q: z.infer<typeof listQuery>) {
    return this.payments.listRefunds(ctx, q);
  }

  @HttpCode(200)
  @Post('refunds/:refundId/complete')
  @RequirePermission('payments:refund')
  completeRefund(@Tenant() ctx: TenantContext, @Param('refundId', ParseUUIDPipe) id: string,
    @Body(zod(completeRefundInput.optional().transform((b) => b ?? {}))) body: z.infer<typeof completeRefundInput>) {
    return this.payments.completeManualRefund(ctx, id, body.note || null);
  }

  /** Asks the provider about a pending or unconfirmed refund now (PAY-05/PAY-12); never sends a second refund while the provider has a record of the first. */
  @Post('refunds/:refundId/check')
  @RequirePermission('payments:refund')
  checkRefund(@Tenant() ctx: TenantContext, @Param('refundId', ParseUUIDPipe) id: string) {
    return this.refundsSvc.check(ctx, id);
  }

  // --- alerts --------------------------------------------------------------------
  @Get('alerts')
  @RequirePermission('payments:read')
  alerts(@Tenant() ctx: TenantContext, @Query(zod(alertsQuery)) q: z.infer<typeof alertsQuery>) {
    return this.payments.alerts(ctx, q);
  }

  @HttpCode(200)
  @Post('alerts/:alertId/resolve')
  @RequirePermission('payments:reconcile')
  resolveAlert(@Tenant() ctx: TenantContext, @Param('alertId', ParseUUIDPipe) id: string) {
    return this.payments.resolveAlert(ctx, id);
  }

  /** One-click provider refund of a capture Resuto never applied (late success, duplicate capture, overpayment) — PAY-08. */
  @Post('alerts/:alertId/refund')
  @RequirePermission('payments:refund')
  refundAlert(@Tenant() ctx: TenantContext, @Param('alertId', ParseUUIDPipe) id: string, @Body(zod(alertRefund)) body: z.infer<typeof alertRefund>) {
    return this.refundsSvc.refundUnappliedCapture(ctx, id, body.key);
  }

  // --- reconciliation ----------------------------------------------------------
  @Get('reconciliation/runs')
  @RequirePermission('payments:reconcile')
  runs(@Tenant() ctx: TenantContext, @Query(zod(runsQuery)) q: z.infer<typeof runsQuery>) {
    return this.reconciliation.listRuns(ctx, q);
  }

  @Post('reconciliation/runs')
  @RequirePermission('payments:reconcile')
  run(@Tenant() ctx: TenantContext, @Body(zod(reconciliationRunInput)) body: z.infer<typeof reconciliationRunInput>) {
    return this.reconciliation.runProvider(ctx, body);
  }

  @Get('reconciliation/runs/:runId')
  @RequirePermission('payments:reconcile')
  getRun(@Tenant() ctx: TenantContext, @Param('runId', ParseUUIDPipe) id: string) {
    return this.reconciliation.getRun(ctx, id);
  }

  @Patch('reconciliation/items/:itemId')
  @RequirePermission('payments:reconcile')
  resolveItem(@Tenant() ctx: TenantContext, @Param('itemId', ParseUUIDPipe) id: string, @Body(zod(resolveReconciliationItem)) body: z.infer<typeof resolveReconciliationItem>) {
    return this.reconciliation.resolveItem(ctx, id, body);
  }

  @Get('reconciliation/cash/expected')
  @RequirePermission('payments:reconcile')
  expectedCash(@Tenant() ctx: TenantContext, @Query(zod(cashQuery)) q: z.infer<typeof cashQuery>) {
    if (new Date(q.to) <= new Date(q.from)) throw invalid('invalid_period', 'The period end must be after its start');
    return this.reconciliation.expectedCash(ctx, q);
  }

  @Post('reconciliation/cash')
  @RequirePermission('payments:reconcile')
  cashCount(@Tenant() ctx: TenantContext, @Body(zod(cashCountInput)) body: z.infer<typeof cashCountInput>) {
    return this.reconciliation.cashCount(ctx, body);
  }

  // --- single payment (keep last: ":paymentId" would shadow the routes above) ----
  @Get(':paymentId')
  @RequirePermission('payments:read')
  detail(@Tenant() ctx: TenantContext, @Param('paymentId', ParseUUIDPipe) id: string) {
    return this.payments.detail(ctx, id);
  }

  @Post(':paymentId/refunds')
  @RequirePermission('payments:refund')
  refund(@Tenant() ctx: TenantContext, @Param('paymentId', ParseUUIDPipe) id: string, @Body(zod(createRefund)) body: z.infer<typeof createRefund>) {
    return this.payments.refund(ctx, id, body);
  }

  @Get(':paymentId/receipt')
  @RequirePermission('payments:read')
  receipt(@Tenant() ctx: TenantContext, @Param('paymentId', ParseUUIDPipe) id: string) {
    return this.payments.receipt(ctx, id);
  }
}
