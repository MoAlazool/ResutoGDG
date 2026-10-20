import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  addDomain, createSection, generateCreative, publishWebsite, reorderSections, reviewCreative, updateMedia, updateSection, updateWebsite,
  upsertStorefront, type UpsertStorefront,
} from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { CreativeService } from './creative.service';
import { DomainsService } from './domains.service';
import { StorefrontsService } from './storefronts.service';
import { StudioService } from './studio.service';

interface UploadedImage { buffer: Buffer; mimetype: string; size: number; originalname: string }

/** ResutoStudio management API: website editor, media library, custom domains and AI creative. */
@Controller('o/:orgId/studio')
@RequiresModule('studio')
export class StudioController {
  constructor(private readonly studio: StudioService, private readonly domains: DomainsService, private readonly creative: CreativeService, private readonly storefronts: StorefrontsService) {}

  // --- Website -----------------------------------------------------------------
  @Get('website')
  @RequirePermission('studio:read')
  website(@Tenant() ctx: TenantContext) {
    return this.studio.get(ctx);
  }

  @Patch('website')
  @RequirePermission('studio:write')
  updateWebsite(@Tenant() ctx: TenantContext, @Body(zod(updateWebsite)) body: z.infer<typeof updateWebsite>) {
    return this.studio.update(ctx, body);
  }

  @Get('website/preview')
  @RequirePermission('studio:read')
  preview(@Tenant() ctx: TenantContext) {
    return this.studio.preview(ctx);
  }

  @Post('website/sections/reorder')
  @RequirePermission('studio:write')
  reorder(@Tenant() ctx: TenantContext, @Body(zod(reorderSections)) body: z.infer<typeof reorderSections>) {
    return this.studio.reorder(ctx, body.ids);
  }

  @Post('website/sections')
  @RequirePermission('studio:write')
  createSection(@Tenant() ctx: TenantContext, @Body(zod(createSection)) body: z.infer<typeof createSection>) {
    return this.studio.createSection(ctx, body);
  }

  @Patch('website/sections/:sectionId')
  @RequirePermission('studio:write')
  updateSection(@Tenant() ctx: TenantContext, @Param('sectionId', ParseUUIDPipe) id: string, @Body(zod(updateSection)) body: z.infer<typeof updateSection>) {
    return this.studio.updateSection(ctx, id, body);
  }

  @Delete('website/sections/:sectionId')
  @RequirePermission('studio:write')
  deleteSection(@Tenant() ctx: TenantContext, @Param('sectionId', ParseUUIDPipe) id: string) {
    return this.studio.deleteSection(ctx, id);
  }

  @Post('website/publish')
  @RequirePermission('studio:publish')
  publish(@Tenant() ctx: TenantContext, @Body(zod(publishWebsite)) body: z.infer<typeof publishWebsite>) {
    return this.studio.publish(ctx, body.key, body.note);
  }

  @Get('website/revisions')
  @RequirePermission('studio:read')
  revisions(@Tenant() ctx: TenantContext) {
    return this.studio.revisions(ctx);
  }

  @Post('website/revisions/:revision/restore')
  @RequirePermission('studio:write')
  restore(@Tenant() ctx: TenantContext, @Param('revision', ParseIntPipe) revision: number) {
    return this.studio.restore(ctx, revision);
  }

  @Get('products')
  @RequirePermission('studio:read')
  products(@Tenant() ctx: TenantContext, @Query('q') q?: string) {
    return this.studio.products(ctx, typeof q === 'string' ? q.slice(0, 80) : undefined);
  }

  // --- Branch storefronts (VP-05) ---------------------------------------------------
  @Get('storefronts')
  @RequirePermission('studio:read')
  listStorefronts(@Tenant() ctx: TenantContext) {
    return this.storefronts.list(ctx);
  }

  @Get('storefronts/:branchId')
  @RequirePermission('studio:read')
  storefront(@Tenant() ctx: TenantContext, @Param('branchId', ParseUUIDPipe) branchId: string) {
    return this.storefronts.get(ctx, branchId);
  }

  @Put('storefronts/:branchId')
  @RequirePermission('studio:publish')
  saveStorefront(@Tenant() ctx: TenantContext, @Param('branchId', ParseUUIDPipe) branchId: string, @Body(zod(upsertStorefront)) body: UpsertStorefront) {
    return this.storefronts.upsert(ctx, branchId, body);
  }

  // --- Media library ---------------------------------------------------------------
  @Get('media')
  @RequirePermission('studio:read')
  media(@Tenant() ctx: TenantContext, @Query('limit') limit?: string) {
    return this.studio.listMedia(ctx, Number(limit) || 100);
  }

  @Post('media')
  @RequirePermission('studio:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024, files: 1 } }))
  upload(@Tenant() ctx: TenantContext, @UploadedFile() file: UploadedImage | undefined, @Body('alt') alt?: string) {
    return this.studio.upload(ctx, file, typeof alt === 'string' ? alt : undefined);
  }

  @Patch('media/:mediaId')
  @RequirePermission('studio:write')
  updateMedia(@Tenant() ctx: TenantContext, @Param('mediaId', ParseUUIDPipe) id: string, @Body(zod(updateMedia)) body: z.infer<typeof updateMedia>) {
    return this.studio.updateMedia(ctx, id, body);
  }

  @Delete('media/:mediaId')
  @RequirePermission('studio:write')
  deleteMedia(@Tenant() ctx: TenantContext, @Param('mediaId', ParseUUIDPipe) id: string) {
    return this.studio.deleteMedia(ctx, id);
  }

  // --- Custom domains --------------------------------------------------------------
  @Get('domains')
  @RequirePermission('studio:read')
  listDomains(@Tenant() ctx: TenantContext) {
    return this.domains.list(ctx);
  }

  @Post('domains')
  @RequirePermission('studio:publish')
  addDomain(@Tenant() ctx: TenantContext, @Body(zod(addDomain)) body: z.infer<typeof addDomain>) {
    return this.domains.add(ctx, body.hostname);
  }

  @Post('domains/:domainId/verify')
  @RequirePermission('studio:publish')
  verifyDomain(@Tenant() ctx: TenantContext, @Param('domainId', ParseUUIDPipe) id: string) {
    return this.domains.verify(ctx, id);
  }

  @Post('domains/:domainId/refresh')
  @RequirePermission('studio:publish')
  refreshDomain(@Tenant() ctx: TenantContext, @Param('domainId', ParseUUIDPipe) id: string) {
    return this.domains.refresh(ctx, id);
  }

  @Delete('domains/:domainId')
  @RequirePermission('studio:publish')
  removeDomain(@Tenant() ctx: TenantContext, @Param('domainId', ParseUUIDPipe) id: string) {
    return this.domains.remove(ctx, id);
  }

  // --- Creative --------------------------------------------------------------------
  @Post('creative')
  @RequirePermission('studio:write')
  generate(@Tenant() ctx: TenantContext, @Body(zod(generateCreative)) body: z.infer<typeof generateCreative>) {
    return this.creative.generate(ctx, body);
  }

  @Get('creative')
  @RequirePermission('studio:read')
  listCreative(@Tenant() ctx: TenantContext, @Query('status') status?: string, @Query('kind') kind?: string, @Query('limit') limit?: string) {
    return this.creative.list(ctx, {
      status: z.enum(['draft', 'approved', 'rejected', 'used']).optional().parse(status || undefined),
      kind: z.enum(['caption', 'post', 'menu_description', 'campaign_copy', 'image', 'website_copy']).optional().parse(kind || undefined),
      limit: Number(limit) || 50,
    });
  }

  @Patch('creative/:creativeId')
  @RequirePermission('studio:write')
  reviewCreative(@Tenant() ctx: TenantContext, @Param('creativeId', ParseUUIDPipe) id: string, @Body(zod(reviewCreative)) body: z.infer<typeof reviewCreative>) {
    return this.creative.review(ctx, id, body.status);
  }
}
