import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  commitExtraction, createTextExtraction, EXTRACTION_MAX_FILE_BYTES, listQueryOf, updateExtractionDraft,
  type CommitExtraction, type CreateTextExtraction, type UpdateExtractionDraft,
} from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, Tenant } from '../../common/auth/decorators';
import { zod } from '../../common/http/zod.pipe';
import { StudioAiService } from './ai/studio-ai.service';
import { MenuExtractionService } from './menu-extraction/menu-extraction.service';

import { z } from 'zod';

const jobsQuery = listQueryOf({ defaultLimit: 20, maxLimit: 50 });

interface UploadedFileLike { buffer: Buffer; mimetype: string; size: number; originalname: string }
const uuid = new ParseUUIDPipe();

/**
 * Studio AI endpoints that belong to the core plan (no Studio entitlement): capability report and menu extraction.
 * Menu extraction writes the menu, so it needs menu:write; the model path additionally needs the restaurant's own key.
 */
@Controller('o/:orgId')
export class StudioAiController {
  constructor(private readonly ai: StudioAiService, private readonly extraction: MenuExtractionService) {}

  @Get('studio-ai/capabilities')
  @RequirePermission('menu:read')
  capabilities(@Tenant() ctx: TenantContext) {
    return this.ai.capabilities(ctx);
  }

  @Get('menu-import/jobs')
  @RequirePermission('menu:write')
  list(@Tenant() ctx: TenantContext, @Query(zod(jobsQuery)) q: z.infer<typeof jobsQuery>) {
    return this.extraction.list(ctx, q);
  }

  @Post('menu-import/jobs/text')
  @RequirePermission('menu:write')
  fromText(@Tenant() ctx: TenantContext, @Body(zod(createTextExtraction)) body: CreateTextExtraction) {
    return this.extraction.createFromText(ctx, body);
  }

  @Post('menu-import/jobs/file')
  @RequirePermission('menu:write')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: EXTRACTION_MAX_FILE_BYTES, files: 1 } }))
  fromFile(@Tenant() ctx: TenantContext, @UploadedFile() file: UploadedFileLike | undefined) {
    return this.extraction.createFromFile(ctx, file);
  }

  @Get('menu-import/jobs/:jobId')
  @RequirePermission('menu:write')
  get(@Tenant() ctx: TenantContext, @Param('jobId', uuid) id: string) {
    return this.extraction.get(ctx, id);
  }

  @Patch('menu-import/jobs/:jobId')
  @RequirePermission('menu:write')
  update(@Tenant() ctx: TenantContext, @Param('jobId', uuid) id: string, @Body(zod(updateExtractionDraft)) body: UpdateExtractionDraft) {
    return this.extraction.updateDraft(ctx, id, body);
  }

  @HttpCode(200)
  @Post('menu-import/jobs/:jobId/commit')
  @RequirePermission('menu:write')
  commit(@Tenant() ctx: TenantContext, @Param('jobId', uuid) id: string, @Body(zod(commitExtraction)) body: CommitExtraction) {
    return this.extraction.commit(ctx, id, body);
  }

  @HttpCode(200)
  @Post('menu-import/jobs/:jobId/discard')
  @RequirePermission('menu:write')
  discard(@Tenant() ctx: TenantContext, @Param('jobId', uuid) id: string) {
    return this.extraction.discard(ctx, id);
  }
}
