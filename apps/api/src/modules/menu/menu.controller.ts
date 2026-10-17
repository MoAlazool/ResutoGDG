import { Body, Controller, Delete, Get, Headers, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  availabilityToggle, categoryInput, categoryReorder, categoryUpdate, menuImportRequest, modifierGroupInput, modifierGroupUpdate,
  modifierOptionInput, modifierOptionUpdate, productBranchSetting, productInput, productModifierAssignment, productUpdate, toCsv,
  type MenuImportRequest, type ProductInput, type ProductUpdate,
} from '@resuto/contracts';
import { z } from 'zod';
import type { ResutoRequest, TenantContext } from '../../common/auth/context';
import { AllowMcp, Public, RequirePermission, Tenant } from '../../common/auth/decorators';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { MenuService } from './menu.service';

interface UploadedImage { buffer: Buffer; mimetype: string; size: number; originalname: string }
const uuidPipe = new ParseUUIDPipe();

@Controller()
export class MenuController {
  constructor(private readonly menu: MenuService) {}

  @Get('o/:orgId/menu')
  @AllowMcp()
  @RequirePermission('menu:read')
  view(@Tenant() ctx: TenantContext) {
    return this.menu.editorView(ctx);
  }

  @Get('o/:orgId/menu/export')
  @RequirePermission('menu:write')
  async export(@Tenant() ctx: TenantContext) {
    const rows = await this.menu.exportCsvRows(ctx);
    return { csv: toCsv(rows), rows: rows.length };
  }

  // Categories ---------------------------------------------------------------
  @Post('o/:orgId/menu/categories')
  @RequirePermission('menu:write')
  createCategory(@Tenant() ctx: TenantContext, @Body(zod(categoryInput)) body: z.infer<typeof categoryInput>) {
    return this.menu.createCategory(ctx, body);
  }

  @Post('o/:orgId/menu/categories/reorder')
  @RequirePermission('menu:write')
  reorder(@Tenant() ctx: TenantContext, @Body(zod(categoryReorder)) body: { ids: string[] }) {
    return this.menu.reorderCategories(ctx, body.ids);
  }

  @Patch('o/:orgId/menu/categories/:id')
  @RequirePermission('menu:write')
  updateCategory(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(categoryUpdate)) body: Record<string, unknown>) {
    return this.menu.updateCategory(ctx, id, body);
  }

  @Delete('o/:orgId/menu/categories/:id')
  @RequirePermission('menu:write')
  archiveCategory(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.menu.archiveCategory(ctx, id);
  }

  // Products -----------------------------------------------------------------
  @Get('o/:orgId/menu/products/:id')
  @AllowMcp()
  @RequirePermission('menu:read')
  product(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.menu.getProduct(ctx, id);
  }

  @Post('o/:orgId/menu/products')
  @RequirePermission('menu:write')
  createProduct(@Tenant() ctx: TenantContext, @Body(zod(productInput)) body: ProductInput) {
    return this.menu.createProduct(ctx, body);
  }

  @Patch('o/:orgId/menu/products/:id')
  @RequirePermission('menu:write')
  updateProduct(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(productUpdate)) body: ProductUpdate) {
    return this.menu.updateProduct(ctx, id, body);
  }

  @Delete('o/:orgId/menu/products/:id')
  @RequirePermission('menu:write')
  archiveProduct(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.menu.archiveProduct(ctx, id);
  }

  @Post('o/:orgId/menu/products/:id/image')
  @RequirePermission('menu:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024, files: 1 } }))
  uploadImage(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @UploadedFile() file: UploadedImage | undefined, @Body('alt') alt?: string) {
    return this.menu.uploadImage(ctx, id, file, typeof alt === 'string' ? alt.slice(0, 200) : undefined);
  }

  @Put('o/:orgId/menu/products/:id/branches/:branchId')
  @RequirePermission('menu:write')
  branchSetting(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Param('branchId', uuidPipe) branchId: string,
    @Body(zod(productBranchSetting)) body: z.infer<typeof productBranchSetting>) {
    return this.menu.setBranchSetting(ctx, id, branchId, body);
  }

  /** Quick availability ("86") toggle for kitchen, waiters and cashiers. */
  @Post('o/:orgId/menu/products/:id/availability')
  @AllowMcp()
  @RequirePermission('menu:availability')
  availability(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(availabilityToggle)) body: { branchId: string; available: boolean }) {
    return this.menu.toggleAvailability(ctx, id, body.branchId, body.available);
  }

  @Put('o/:orgId/menu/products/:id/modifier-groups')
  @RequirePermission('menu:write')
  assign(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(productModifierAssignment)) body: { groupIds: string[] }) {
    return this.menu.assignGroups(ctx, id, body.groupIds);
  }

  // Modifier groups and options ----------------------------------------------
  @Post('o/:orgId/menu/modifier-groups')
  @RequirePermission('menu:write')
  createGroup(@Tenant() ctx: TenantContext, @Body(zod(modifierGroupInput)) body: z.infer<typeof modifierGroupInput>) {
    return this.menu.createGroup(ctx, body);
  }

  @Patch('o/:orgId/menu/modifier-groups/:id')
  @RequirePermission('menu:write')
  updateGroup(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(modifierGroupUpdate)) body: Record<string, unknown>) {
    return this.menu.updateGroup(ctx, id, body);
  }

  @Delete('o/:orgId/menu/modifier-groups/:id')
  @RequirePermission('menu:write')
  archiveGroup(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.menu.archiveGroup(ctx, id);
  }

  @Post('o/:orgId/menu/modifier-groups/:id/options')
  @RequirePermission('menu:write')
  createOption(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(modifierOptionInput)) body: z.infer<typeof modifierOptionInput>) {
    return this.menu.createOption(ctx, id, body);
  }

  @Patch('o/:orgId/menu/modifier-options/:id')
  @RequirePermission('menu:write')
  updateOption(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string, @Body(zod(modifierOptionUpdate)) body: Record<string, unknown>) {
    return this.menu.updateOption(ctx, id, body);
  }

  @Delete('o/:orgId/menu/modifier-options/:id')
  @RequirePermission('menu:write')
  deleteOption(@Tenant() ctx: TenantContext, @Param('id', uuidPipe) id: string) {
    return this.menu.deleteOption(ctx, id);
  }

  // Import (§8) --------------------------------------------------------------
  @Post('o/:orgId/menu/import/preview')
  @RequirePermission('menu:write')
  importPreview(@Tenant() ctx: TenantContext, @Body(zod(menuImportRequest)) body: MenuImportRequest) {
    return this.menu.importPreview(ctx, body);
  }

  @Post('o/:orgId/menu/import/commit')
  @RequirePermission('menu:write')
  importCommit(@Tenant() ctx: TenantContext, @Body(zod(menuImportRequest)) body: MenuImportRequest, @Headers('idempotency-key') key?: string) {
    return this.menu.importCommit(ctx, body, key);
  }
}

@Controller('public/menu')
export class PublicMenuController {
  constructor(private readonly menu: MenuService, private readonly limiter: RateLimiter) {}

  @Public()
  @Get(':slug')
  get(@Param('slug') slug: string, @Query('branch') branch: string | undefined, @Req() req: ResutoRequest) {
    this.limiter.hit(`public-menu:${req.ip}`, 120);
    const s = z.string().regex(/^[a-z0-9-]{1,60}$/).safeParse(slug);
    if (!s.success) return this.menu.publicMenu('__invalid__');
    return this.menu.publicMenu(s.data, typeof branch === 'string' ? branch.slice(0, 60) : undefined);
  }
}
