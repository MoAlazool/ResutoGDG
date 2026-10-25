import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Put, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  addDomain, createSection, generateCreative, publishWebsite, reorderSections, reviewCreative, updateMedia, updateSection, updateWebsite,
  upsertStorefront, type UpsertStorefront, createPhotoJob, PHOTO_JOB_STATUSES, publishPhotoJob, reviewPhotoJob, type CreatePhotoJob, type PublishPhotoJob,
  applyCreative, type ApplyCreative, fullListQuery, listQueryOf, applyWebsiteTemplate, type ApplyWebsiteTemplate,
} from '@resuto/contracts';
import { StudioPhotosService } from './photos/photos.service';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { CreativeService } from './creative.service';
import { DomainsService } from './domains.service';
import { StorefrontsService } from './storefronts.service';
import { StudioService } from './studio.service';

// List queries (PS-21): validated limit/cursor instead of Number(limit) (a negative limit was a 500).
const mediaQuery = listQueryOf({ defaultLimit: 100 });
const revisionsQuery = listQueryOf({ defaultLimit: 50 });
const creativeQuery = listQueryOf({ defaultLimit: 50 }).extend({
  status: z.enum(['draft', 'approved', 'rejected', 'used']).optional().or(z.literal('').transform(() => undefined)),
  kind: z.enum(['caption', 'post', 'menu_description', 'campaign_copy', 'image', 'website_copy']).optional().or(z.literal('').transform(() => undefined)),
});

const productsQuery = z.object({ q: z.string().max(200).optional().transform((v) => v?.slice(0, 80)) });
const photosQuery = z.object({ status: z.enum(PHOTO_JOB_STATUSES).optional().or(z.literal('').transform(() => undefined)) });

interface UploadedImage { buffer: Buffer; mimetype: string; size: number; originalname: string }

/** ResutoStudio management API: website editor, media library, custom domains and AI creative. */
@Controller('o/:orgId/studio')
@RequiresModule('studio')
export class StudioController {
  constructor(private readonly studio: StudioService, private readonly domains: DomainsService, private readonly creative: CreativeService, private readonly storefronts: StorefrontsService,
    private readonly photosService: StudioPhotosService) {}

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

  /** The draft as it will look once a change set is applied (21-STUDIO canvas diff); nothing is written. */
  @Get('website/preview/change-sets/:changeSetId')
  @RequirePermission('studio:read')
  changeSetPreview(@Tenant() ctx: TenantContext, @Param('changeSetId', ParseUUIDPipe) id: string) {
    return this.studio.changeSetPreview(ctx, id);
  }

  /** Applies a style family × layout variant (21-STUDIO templates) to the draft; never deletes a section. */
  @HttpCode(200)
  @Post('website/template')
  @RequirePermission('studio:write')
  applyTemplate(@Tenant() ctx: TenantContext, @Body(zod(applyWebsiteTemplate)) body: ApplyWebsiteTemplate) {
    return this.studio.applyTemplate(ctx, body);
  }

  @HttpCode(200)
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

  @HttpCode(200)
  @Post('website/publish')
  @RequirePermission('studio:publish')
  publish(@Tenant() ctx: TenantContext, @Body(zod(publishWebsite)) body: z.infer<typeof publishWebsite>) {
    return this.studio.publish(ctx, body.key, body.note);
  }

  @Get('website/revisions')
  @RequirePermission('studio:read')
  revisions(@Tenant() ctx: TenantContext, @Query(zod(revisionsQuery)) q: z.infer<typeof revisionsQuery>) {
    return this.studio.revisions(ctx, q);
  }

  @HttpCode(200)
  @Post('website/revisions/:revision/restore')
  @RequirePermission('studio:write')
  restore(@Tenant() ctx: TenantContext, @Param('revision', ParseIntPipe) revision: number) {
    return this.studio.restore(ctx, revision);
  }

  @Get('products')
  @RequirePermission('studio:read')
  products(@Tenant() ctx: TenantContext, @Query(zod(productsQuery)) q: z.infer<typeof productsQuery>) {
    return this.studio.products(ctx, q.q);
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
  media(@Tenant() ctx: TenantContext, @Query(zod(mediaQuery)) q: z.infer<typeof mediaQuery>) {
    return this.studio.listMedia(ctx, q);
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
  @Header('X-Resuto-List', 'full')
  listDomains(@Tenant() ctx: TenantContext, @Query(zod(fullListQuery)) q: z.infer<typeof fullListQuery>) {
    return this.domains.list(ctx, q);
  }

  @Post('domains')
  @RequirePermission('studio:publish')
  addDomain(@Tenant() ctx: TenantContext, @Body(zod(addDomain)) body: z.infer<typeof addDomain>) {
    return this.domains.add(ctx, body.hostname);
  }

  @HttpCode(200)
  @Post('domains/:domainId/verify')
  @RequirePermission('studio:publish')
  verifyDomain(@Tenant() ctx: TenantContext, @Param('domainId', ParseUUIDPipe) id: string) {
    return this.domains.verify(ctx, id);
  }

  @HttpCode(200)
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

  // --- Food photos (FT-04): upload -> job -> review -> approve -> publish ------------
  @Get('photos')
  @RequirePermission('studio:read')
  photos(@Tenant() ctx: TenantContext, @Query(zod(photosQuery)) q: z.infer<typeof photosQuery>) {
    return this.photosService.list(ctx, q.status);
  }

  @Post('photos')
  @RequirePermission('studio:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024, files: 1 } }))
  uploadPhoto(@Tenant() ctx: TenantContext, @UploadedFile() file: UploadedImage | undefined, @Body() body: Record<string, unknown>) {
    let params: unknown = undefined;
    if (typeof body?.params === 'string' && body.params) {
      try { params = JSON.parse(body.params); } catch { params = '__invalid__'; }
    }
    const input = zod(createPhotoJob).transform({ productId: body?.productId || undefined, mode: body?.mode || undefined, params });
    return this.photosService.create(ctx, file, input as CreatePhotoJob);
  }

  @Get('photos/:jobId')
  @RequirePermission('studio:read')
  photo(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) id: string) {
    return this.photosService.get(ctx, id);
  }

  @HttpCode(200)
  @Post('photos/:jobId/review')
  @RequirePermission('studio:write')
  reviewPhoto(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) id: string, @Body(zod(reviewPhotoJob)) body: z.infer<typeof reviewPhotoJob>) {
    return this.photosService.review(ctx, id, body.decision, body.note);
  }

  @HttpCode(200)
  @Post('photos/:jobId/publish')
  @RequirePermission('studio:write')
  publishPhoto(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) id: string, @Body(zod(publishPhotoJob)) body: PublishPhotoJob) {
    return this.photosService.publish(ctx, id, body);
  }

  @HttpCode(200)
  @Post('photos/:jobId/retry')
  @RequirePermission('studio:write')
  retryPhoto(@Tenant() ctx: TenantContext, @Param('jobId', ParseUUIDPipe) id: string) {
    return this.photosService.retry(ctx, id);
  }

  // --- Creative --------------------------------------------------------------------
  @Post('creative')
  @RequirePermission('studio:write')
  generate(@Tenant() ctx: TenantContext, @Body(zod(generateCreative)) body: z.infer<typeof generateCreative>) {
    return this.creative.generate(ctx, body);
  }

  @Get('creative')
  @RequirePermission('studio:read')
  listCreative(@Tenant() ctx: TenantContext, @Query(zod(creativeQuery)) q: z.infer<typeof creativeQuery>) {
    return this.creative.list(ctx, q);
  }

  @Patch('creative/:creativeId')
  @RequirePermission('studio:write')
  reviewCreative(@Tenant() ctx: TenantContext, @Param('creativeId', ParseUUIDPipe) id: string, @Body(zod(reviewCreative)) body: z.infer<typeof reviewCreative>) {
    return this.creative.review(ctx, id, body.status);
  }

  /** FT-16: use approved copy (menu item description, website section draft or campaign draft); idempotent per key. */
  @HttpCode(200)
  @Post('creative/:creativeId/apply')
  @RequirePermission('studio:write')
  applyCreative(@Tenant() ctx: TenantContext, @Param('creativeId', ParseUUIDPipe) id: string, @Body(zod(applyCreative)) body: ApplyCreative) {
    return this.creative.apply(ctx, id, body);
  }
}
