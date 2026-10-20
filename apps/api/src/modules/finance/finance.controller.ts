import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { accountingPush, createExport, expenseCategoryInput, expenseInput, expenseUpdate, financePeriod, listExpensesQuery } from '@resuto/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { AccountingService } from './accounting.service';
import { ExpensesService } from './expenses.service';
import { ExportsService } from './exports.service';
import { FinanceService } from './finance.service';

type Period = z.infer<typeof financePeriod>;

/** Resuto Finance (paid module `finance`). */
@Controller('o/:orgId/finance')
@RequiresModule('finance')
export class FinanceController {
  constructor(
    private readonly finance: FinanceService,
    private readonly expenses: ExpensesService,
    private readonly exports: ExportsService,
    private readonly accounting: AccountingService,
  ) {}

  @Get('overview')
  @RequirePermission('finance:read')
  overview(@Tenant() ctx: TenantContext, @Query(zod(financePeriod)) p: Period) {
    return this.finance.overview(ctx, p);
  }

  @Get('pnl')
  @RequirePermission('finance:read')
  pnl(@Tenant() ctx: TenantContext, @Query(zod(financePeriod)) p: Period) {
    return this.finance.pnl(ctx, p);
  }

  @Get('fees')
  @RequirePermission('finance:read')
  fees(@Tenant() ctx: TenantContext, @Query(zod(financePeriod)) p: Period) {
    return this.finance.fees(ctx, p);
  }

  @Get('reconciliation')
  @RequirePermission('finance:read')
  reconciliation(@Tenant() ctx: TenantContext, @Query(zod(financePeriod)) p: Period) {
    return this.finance.reconciliationSummary(ctx, p);
  }

  @Get('insights')
  @RequirePermission('finance:read')
  insights(@Tenant() ctx: TenantContext, @Query(zod(financePeriod)) p: Period) {
    return this.finance.insights(ctx, p);
  }

  // --- expenses ------------------------------------------------------------------
  @Get('expense-categories')
  @RequirePermission('finance:read')
  categories(@Tenant() ctx: TenantContext) {
    return this.expenses.categories(ctx);
  }

  @Post('expense-categories')
  @RequirePermission('finance:write')
  createCategory(@Tenant() ctx: TenantContext, @Body(zod(expenseCategoryInput)) body: z.infer<typeof expenseCategoryInput>) {
    return this.expenses.createCategory(ctx, body);
  }

  @Get('expenses')
  @RequirePermission('finance:read')
  listExpenses(@Tenant() ctx: TenantContext, @Query(zod(listExpensesQuery)) q: z.infer<typeof listExpensesQuery>) {
    return this.expenses.list(ctx, q);
  }

  @Post('expenses')
  @RequirePermission('finance:write')
  createExpense(@Tenant() ctx: TenantContext, @Body(zod(expenseInput)) body: z.infer<typeof expenseInput>) {
    return this.expenses.create(ctx, body);
  }

  @Get('expenses/:expenseId')
  @RequirePermission('finance:read')
  getExpense(@Tenant() ctx: TenantContext, @Param('expenseId', ParseUUIDPipe) id: string) {
    return this.expenses.get(ctx, id);
  }

  @Patch('expenses/:expenseId')
  @RequirePermission('finance:write')
  updateExpense(@Tenant() ctx: TenantContext, @Param('expenseId', ParseUUIDPipe) id: string, @Body(zod(expenseUpdate)) body: z.infer<typeof expenseUpdate>) {
    return this.expenses.update(ctx, id, body as any);
  }

  @Delete('expenses/:expenseId')
  @RequirePermission('finance:write')
  deleteExpense(@Tenant() ctx: TenantContext, @Param('expenseId', ParseUUIDPipe) id: string) {
    return this.expenses.remove(ctx, id);
  }

  @Post('expenses/:expenseId/receipt')
  @RequirePermission('finance:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024, files: 1 } }))
  receipt(@Tenant() ctx: TenantContext, @Param('expenseId', ParseUUIDPipe) id: string, @UploadedFile() file?: { buffer: Buffer; mimetype: string }) {
    return this.expenses.attachReceipt(ctx, id, file);
  }

  // --- exports -------------------------------------------------------------------
  @Get('exports')
  @RequirePermission('finance:read')
  listExports(@Tenant() ctx: TenantContext) {
    return this.exports.list(ctx);
  }

  @Post('exports')
  @RequirePermission('finance:read')
  createExport(@Tenant() ctx: TenantContext, @Body(zod(createExport)) body: z.infer<typeof createExport>) {
    return this.exports.create(ctx, body);
  }

  @Get('exports/:exportId/download')
  @RequirePermission('finance:read')
  async download(@Tenant() ctx: TenantContext, @Param('exportId', ParseUUIDPipe) id: string, @Res() res: Response) {
    const file = await this.exports.download(ctx, id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
    res.setHeader('X-Content-SHA256', file.checksum);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file.content);
  }

  // --- accounting ----------------------------------------------------------------
  @Get('accounting/journal')
  @RequirePermission('finance:read')
  journal(@Tenant() ctx: TenantContext, @Query(zod(financePeriod)) p: Period) {
    return this.accounting.journal(ctx, p);
  }

  @Get('accounting/pushes')
  @RequirePermission('finance:read')
  pushes(@Tenant() ctx: TenantContext) {
    return this.accounting.listPushes(ctx);
  }

  @Post('accounting/push')
  @RequirePermission('finance:write')
  push(@Tenant() ctx: TenantContext, @Body(zod(accountingPush)) body: z.infer<typeof accountingPush>) {
    return this.accounting.push(ctx, body);
  }
}
