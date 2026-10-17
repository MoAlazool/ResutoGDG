import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  cashCountInput, collectPayment, createPaymentLink, createRefund, isoDateTime, listPaymentsQuery, reconciliationRunInput, resolveReconciliationItem, uuid,
} from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { AllowMcp, RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { invalid, notFound } from '../../common/errors/domain-error';
import { zod } from '../../common/http/zod.pipe';
import { PaymentLedgerService } from '../kernel/payment-ledger.service';
import { ReconciliationService } from './reconciliation.service';
import { StaffPaymentsService } from './staff-payments.service';

const cashQuery = z.object({ branchId: uuid, from: isoDateTime, to: isoDateTime });
const dueQuery = z.object({ orderId: uuid.optional(), visitId: uuid.optional() }).refine((q) => !!(q.orderId || q.visitId), 'orderId or visitId is required');
const listQuery = z.object({ status: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) });

/** Staff ResutoPay endpoints (paid module `pay`). */
@Controller('o/:orgId/payments')
@RequiresModule('pay')
export class PaymentsStaffController {
  constructor(
    private readonly payments: StaffPaymentsService,
    private readonly reconciliation: ReconciliationService,
    private readonly ledger: PaymentLedgerService,
    private readonly db: DbService,
  ) {}

  @Get()
  @RequirePermission('payments:read')
  @AllowMcp()
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
  @AllowMcp()
  links(@Tenant() ctx: TenantContext, @Query(zod(listQuery)) q: z.infer<typeof listQuery>) {
    return this.payments.listLinks(ctx, q);
  }

  @Post('links')
  @RequirePermission('payments:collect')
  @AllowMcp()
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

  @Post('refunds/:refundId/complete')
  @RequirePermission('payments:refund')
  completeRefund(@Tenant() ctx: TenantContext, @Param('refundId', ParseUUIDPipe) id: string, @Body() body: { note?: string } = {}) {
    const note = typeof body?.note === 'string' ? body.note.slice(0, 300) : null;
    return this.payments.completeManualRefund(ctx, id, note);
  }

  // --- alerts --------------------------------------------------------------------
  @Get('alerts')
  @RequirePermission('payments:read')
  alerts(@Tenant() ctx: TenantContext, @Query('status') status?: string) {
    const s = z.enum(['open', 'resolved', 'all']).default('open').parse(status);
    return this.payments.alerts(ctx, s);
  }

  @Post('alerts/:alertId/resolve')
  @RequirePermission('payments:reconcile')
  resolveAlert(@Tenant() ctx: TenantContext, @Param('alertId', ParseUUIDPipe) id: string) {
    return this.payments.resolveAlert(ctx, id);
  }

  // --- reconciliation ----------------------------------------------------------
  @Get('reconciliation/runs')
  @RequirePermission('payments:reconcile')
  runs(@Tenant() ctx: TenantContext) {
    return this.reconciliation.listRuns(ctx);
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
  @AllowMcp()
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
