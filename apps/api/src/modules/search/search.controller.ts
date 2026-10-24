import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import type { TenantContext } from '../../common/auth/context';
import { Tenant } from '../../common/auth/decorators';
import { RateLimiter } from '../../common/http/rate-limiter';
import { zod } from '../../common/http/zod.pipe';
import { SearchService } from './search.service';

/** GET /o/:orgId/search query: the text (1-80 characters after trimming) and an optional branch to narrow to. */
export const searchQuery = z.object({
  q: z.string().trim().min(1).max(80),
  branchId: z.uuid().optional(),
});

/** Searches per member per minute (the palette debounces typing; this stops scripted scraping). */
export const SEARCH_PER_MINUTE = 60;

@Controller('o/:orgId/search')
export class SearchController {
  constructor(private readonly search: SearchService, private readonly limiter: RateLimiter) {}

  /**
   * Orders, customers and menu products matching `q`, for the command palette. Each type is included only when the
   * caller's role may read it (orders:read, customers:read, menu:read); a role that may read none is refused.
   */
  @Get()
  find(@Tenant() ctx: TenantContext, @Query(zod(searchQuery)) q: z.infer<typeof searchQuery>) {
    this.limiter.hit(`search:${ctx.orgId}:${ctx.actorId}`, SEARCH_PER_MINUTE);
    return this.search.search(ctx, { q: q.q, branchId: q.branchId ?? null });
  }
}
