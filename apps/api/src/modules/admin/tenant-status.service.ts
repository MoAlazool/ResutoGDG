import { Injectable } from '@nestjs/common';
import { BoundedCache } from '../../common/cache/bounded-cache';
import { DbService } from '../../common/db/db.service';

/**
 * Cached suspension lookups for platform tooling. Tenant routes are protected by
 * AccessGuard, which rejects suspended organizations on every request.
 */
@Injectable()
export class TenantStatusService {
  /** Bounded per-instance cache (PCL-25): 20k organizations, 10 s each. */
  private readonly cache = new BoundedCache<boolean>(20_000, 10_000);

  constructor(private readonly db: DbService) {}

  async isSuspended(orgId: string): Promise<boolean> {
    const hit = this.cache.get(orgId);
    if (hit !== undefined) return hit;
    const row = await this.db.withPlatform((tx) => tx.maybeOne<{ status: string }>('select status from organizations where id = $1', [orgId]));
    const suspended = row?.status === 'suspended';
    this.cache.set(orgId, suspended);
    return suspended;
  }

  invalidate(orgId: string) {
    this.cache.delete(orgId);
  }
}
