import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  savedReportInput, savedReportListQuery, savedReportUpdate, type SavedReportInput, type SavedReportListQuery, type SavedReportUpdate,
} from '@resuto/contracts/reports';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, Tenant } from '../../common/auth/decorators';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { ReportsService } from './reports.service';

/** Report saves and changes per member per minute (one per click in the Insights toolbar; this stops scripted writes). */
export const REPORT_WRITES_PER_MINUTE = 30;

/**
 * Saved Insights reports (21-INSIGHTS): a member saves the view they are looking at and reopens it later; private by
 * default, optionally shared with colleagues who may read analytics. Every route needs analytics:read; changes and
 * deletes are the author's own (a colleague's shared report answers 404).
 */
@Controller('o/:orgId/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService, private readonly limiter: RateLimiter) {}

  /** The caller's reports and colleagues' shared ones, most recently changed first. */
  @Get()
  @RequirePermission('analytics:read')
  list(@Tenant() ctx: TenantContext, @Query(zod(savedReportListQuery)) q: SavedReportListQuery) {
    return this.reports.list(ctx, q);
  }

  @Get(':reportId')
  @RequirePermission('analytics:read')
  get(@Tenant() ctx: TenantContext, @Param('reportId', ParseUUIDPipe) reportId: string) {
    return this.reports.get(ctx, reportId);
  }

  @Post()
  @RequirePermission('analytics:read')
  create(@Tenant() ctx: TenantContext, @Body(zod(savedReportInput)) body: SavedReportInput) {
    this.limiter.hit(`reports:${ctx.orgId}:${ctx.actorId}`, REPORT_WRITES_PER_MINUTE);
    return this.reports.create(ctx, body);
  }

  @Patch(':reportId')
  @RequirePermission('analytics:read')
  update(@Tenant() ctx: TenantContext, @Param('reportId', ParseUUIDPipe) reportId: string, @Body(zod(savedReportUpdate)) body: SavedReportUpdate) {
    this.limiter.hit(`reports:${ctx.orgId}:${ctx.actorId}`, REPORT_WRITES_PER_MINUTE);
    return this.reports.update(ctx, reportId, body);
  }

  @Delete(':reportId')
  @RequirePermission('analytics:read')
  remove(@Tenant() ctx: TenantContext, @Param('reportId', ParseUUIDPipe) reportId: string) {
    return this.reports.remove(ctx, reportId);
  }
}
