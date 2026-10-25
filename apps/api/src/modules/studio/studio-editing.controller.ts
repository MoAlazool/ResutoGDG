import { Body, Controller, Headers, Post } from '@nestjs/common';
import { studioAiProposal, type StudioAiProposal } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { RequirePermission, RequiresModule, Tenant } from '../../common/auth/decorators';
import { badRequest } from '../../common/errors/domain-error';
import { zod } from '../../common/http/zod.pipe';
import { StudioEditingService } from './ai/studio-editing.service';

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{8,200}$/;

/**
 * Studio AI editing (21-STUDIO): "Add an Eid offers section with these 3 dishes at 15% off" → one change set
 * (origin studio_ai) that waits for approval in the approvals inbox. The canvas renders it with
 * GET /studio/website/preview/change-sets/:id before anyone decides. Idempotent per Idempotency-Key.
 */
@Controller('o/:orgId/studio/ai')
@RequiresModule('studio')
export class StudioEditingController {
  constructor(private readonly editing: StudioEditingService) {}

  @Post('proposals')
  @RequirePermission('studio:write')
  propose(@Tenant() ctx: TenantContext, @Body(zod(studioAiProposal)) body: StudioAiProposal, @Headers('idempotency-key') key?: string) {
    if (!key) throw badRequest('idempotency_key_required', 'An Idempotency-Key header is required');
    if (!IDEMPOTENCY_KEY.test(key)) throw badRequest('invalid_idempotency_key', 'Idempotency-Key must be 8-200 printable characters');
    return this.editing.propose(ctx, body, key);
  }
}
