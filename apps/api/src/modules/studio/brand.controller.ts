import { Body, Controller, Get, HttpCode, Post, Put, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { publishBrand, updateBrand, type UpdateBrand } from '@resuto/contracts';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { BrandService } from './brand.service';

/** Logos are small: 5 MB is generous for a PNG/JPEG/WebP logo (the Studio library takes 15 MB photos). */
const LOGO_MAX_BYTES = 5 * 1024 * 1024;

interface UploadedImage { buffer: Buffer; mimetype: string; size: number; originalname: string }

/**
 * studio_basic (21-ONB increment 2): logo, colours, theme presets and publishing the site, on every plan. These routes
 * need only the core module; the rest of the Studio (/o/:orgId/studio/...) needs the studio module. The request
 * bodies are strict, so nothing beyond studio_basic can be changed through them.
 */
@Controller('o/:orgId/brand')
@RequiresModule('core')
export class BrandController {
  constructor(private readonly brand: BrandService) {}

  @Get()
  @RequirePermission('studio:read')
  get(@Tenant() ctx: TenantContext) {
    return this.brand.view(ctx);
  }

  @Put()
  @RequirePermission('studio:write')
  update(@Tenant() ctx: TenantContext, @Body(zod(updateBrand)) body: UpdateBrand) {
    return this.brand.update(ctx, body);
  }

  @Get('presets')
  @RequirePermission('studio:read')
  presets(@Tenant() ctx: TenantContext) {
    return this.brand.presets(ctx);
  }

  @Post('logo')
  @RequirePermission('studio:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_MAX_BYTES, files: 1 } }))
  logo(@Tenant() ctx: TenantContext, @UploadedFile() file: UploadedImage | undefined) {
    return this.brand.uploadLogo(ctx, file);
  }

  @HttpCode(200)
  @Post('publish')
  @RequirePermission('studio:publish')
  publish(@Tenant() ctx: TenantContext, @Body(zod(publishBrand)) body: z.infer<typeof publishBrand>) {
    return this.brand.publish(ctx, body.key);
  }
}
