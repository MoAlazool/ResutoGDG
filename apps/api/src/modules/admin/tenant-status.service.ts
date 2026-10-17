import { Injectable } from '@nestjs/common';
import { DbService } from '../../common/db/db.service';

/**
 * Cached suspension lookups for platform tooling. Tenant routes are protected by
 * AccessGuard, which rejects suspended organizations on every request.
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
