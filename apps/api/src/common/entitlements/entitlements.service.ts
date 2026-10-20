import { Injectable } from '@nestjs/common';
import type { ModuleKey } from '@resuto/contracts';
import { BoundedCache } from '../cache/bounded-cache';
import { DbService } from '../db/db.service';
import { paymentRequired } from '../errors/domain-error';

/** Backend enforcement of module entitlements (see app.module_enabled in SQL). */
@Injectable()
export class EntitlementsService {
  /**
   * Per-instance, bounded (PCL-25): 20k (org, module) entries, 15 s each. Another instance sees a plan change within
   * 15 s at most; this instance immediately (invalidate). See docs/CACHE_POLICY.md.
   */
  private readonly cache = new BoundedCache<boolean>(20_000, 15_000);

  constructor(private readonly db: DbService) {}

  async isEnabled(orgId: string, module: ModuleKey): Promise<boolean> {
    const key = `${orgId}:${module}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;
    const { enabled } = await this.db.withPlatform((tx) => tx.one<{ enabled: boolean }>(
      'select app.module_enabled($1, $2) as enabled', [orgId, module]));
    this.cache.set(key, enabled);
    return enabled;
  }

  async assert(orgId: string, module: ModuleKey): Promise<void> {
    if (!(await this.isEnabled(orgId, module))) throw paymentRequired(module);
  }

  /** Call after subscription changes so the next request sees the new plan. */
  invalidate(orgId: string) {
    this.cache.deleteWhere((k) => k.startsWith(`${orgId}:`));
  }
}
