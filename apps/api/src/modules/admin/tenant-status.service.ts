import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { DbService } from '../../common/db/db.service';

/**
 * Suspension enforcement for tenant routes. A suspended organization answers
 * every `/v1/o/:orgId/...` request with the same 404 an unknown tenant gets
 * (existence is never confirmed). Cached per process for 10 s and invalidated
 * immediately by the admin suspend/reactivate endpoints on this instance.
 *
 * NOTE for the lead: the cleaner home for this check is AccessGuard.tenantFor
 * (`o.status not in ('closed', 'suspended')`); once that lands this middleware
 * can be deleted. See the Agent A hand-off report.
 */
@Injectable()
export class TenantStatusService {
  private readonly cache = new Map<string, { suspended: boolean; at: number }>();
  private static readonly TTL_MS = 10_000;

  constructor(private readonly db: DbService) {}

  async isSuspended(orgId: string): Promise<boolean> {
    const hit = this.cache.get(orgId);
    if (hit && Date.now() - hit.at < TenantStatusService.TTL_MS) return hit.suspended;
    const row = await this.db.withPlatform((tx) => tx.maybeOne<{ status: string }>('select status from organizations where id = $1', [orgId]));
    const suspended = row?.status === 'suspended';
    this.cache.set(orgId, { suspended, at: Date.now() });
    if (this.cache.size > 20_000) this.cache.clear();
    return suspended;
  }

  invalidate(orgId: string) {
    this.cache.delete(orgId);
  }
}

const TENANT_PATH = /^\/v1\/o\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

@Injectable()
export class SuspendedTenantMiddleware implements NestMiddleware {
  constructor(private readonly status: TenantStatusService) {}

  async use(req: Request & { id?: string }, res: Response, next: NextFunction) {
    const m = TENANT_PATH.exec(req.originalUrl ?? req.url);
    if (!m) return next();
    try {
      if (await this.status.isSuspended(m[1]!)) {
        res.status(404).json({ error: { code: 'not_found', message: 'Restaurant not found', requestId: req.id } });
        return;
      }
    } catch (error) {
      return next(error);
    }
    next();
  }
}
