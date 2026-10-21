import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res } from '@nestjs/common';
import { anonymiseInput, consentUpdate, customerListQuery, customerUpdate, mergeInput } from '@resuto/contracts';
import type { Response } from 'express';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, Tenant } from '../../common/auth/decorators';
import { DbService } from '../../common/db/db.service';
import { zod } from '../../common/http/zod.pipe';
import { CustomersService } from './customers.service';

@Controller('o/:orgId/customers')
export class CustomersController {
  constructor(private readonly db: DbService, private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('customers:read')
  list(@Tenant() ctx: TenantContext, @Query(zod(customerListQuery)) q: z.infer<typeof customerListQuery>) {
    return this.db.scoped(ctx, (tx) => this.customers.list(tx, ctx, q));
  }

  /** Minimal-PII CSV of the filtered list (audited). */
  @Get('export.csv')
  @RequirePermission('customers:read', 'customers:export')
  async export(@Tenant() ctx: TenantContext, @Query(zod(customerListQuery)) q: z.infer<typeof customerListQuery>, @Res({ passthrough: true }) res: Response) {
    const out = await this.db.scoped(ctx, (tx) => this.customers.exportCsv(tx, ctx, q));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Export-Rows', String(out.rows));
    res.setHeader('X-Export-Truncated', String(out.truncated));
    // UTF-8 BOM so spreadsheet apps read Arabic names correctly.
    return '﻿' + out.csv;
  }

  @Get(':id')
  @RequirePermission('customers:read')
  get(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.scoped(ctx, (tx) => this.customers.get(tx, ctx, id));
  }

  @Patch(':id')
  @RequirePermission('customers:write')
  update(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(customerUpdate)) body: z.infer<typeof customerUpdate>) {
    return this.db.scoped(ctx, (tx) => this.customers.update(tx, ctx, id, body));
  }

  @HttpCode(200)
  @Post(':id/consent')
  @RequirePermission('customers:write')
  consent(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(consentUpdate)) body: z.infer<typeof consentUpdate>) {
    return this.db.scoped(ctx, (tx) => this.customers.setConsent(tx, ctx, id, body));
  }

  /** Irreversible. Needs customers:write and customers:export (owner/admin by default) and all-branch access. */
  @HttpCode(200)
  @Post(':id/anonymise')
  @RequirePermission('customers:write', 'customers:export')
  anonymise(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(anonymiseInput)) body: z.infer<typeof anonymiseInput>) {
    return this.db.scoped(ctx, (tx) => this.customers.anonymise(tx, ctx, id, body));
  }

  /** Merges body.duplicateId into :id (the surviving profile). */
  @HttpCode(200)
  @Post(':id/merge')
  @RequirePermission('customers:write')
  merge(@Tenant() ctx: TenantContext, @Param('id', ParseUUIDPipe) id: string, @Body(zod(mergeInput)) body: z.infer<typeof mergeInput>) {
    return this.db.scoped(ctx, (tx) => this.customers.merge(tx, ctx, id, body.duplicateId));
  }
}
