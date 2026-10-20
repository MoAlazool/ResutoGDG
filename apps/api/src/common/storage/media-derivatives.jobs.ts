import { Injectable, Logger } from '@nestjs/common';
import { BoundedCache } from '../cache/bounded-cache';
import { DbService } from '../db/db.service';
import { Scheduled } from '../events/events';
import { DERIVED_FOLDERS, deriveImage } from './image-variants';
import { StorageService } from './storage.service';

/** Objects per run: derivatives decode the original, so the backlog drains in small steps. */
const PER_RUN = 20;
/** An object whose read failed transiently is left unchecked and retried, but not before this cool-down. */
const RETRY_AFTER_MS = 30 * 60_000;

/**
 * Backfill of image derivatives (CR-12) for media recorded before derivatives existed (demo seeds, older uploads) or
 * while the image library was unavailable. Uploads produce their derivatives inline; this job only catches up.
 * Each object is read and transformed outside any transaction; the row update is a short statement of its own.
 */
@Injectable()
export class MediaDerivativeJobs {
  private readonly logger = new Logger('MediaDerivatives');
  /** Objects whose last read failed transiently (bounded, per process): skipped until the cool-down ends. */
  private readonly coolingDown = new BoundedCache<true>(1000, RETRY_AFTER_MS);

  constructor(private readonly db: DbService, private readonly storage: StorageService) {}

  @Scheduled('media.derivatives', 300, { timeoutMs: 10 * 60_000 })
  async backfill(limit = PER_RUN) {
    const cooling = this.coolingDown.keys();
    const rows = await this.db.withPlatform((tx) => tx.query<{ id: string; path: string }>(
      `select id, path from media_assets
        where variants_checked_at is null and content_type in ('image/png', 'image/jpeg', 'image/webp')
          and id <> all($2::uuid[])
        order by created_at limit $1`, [limit, cooling]), 'media.derivatives');
    let derived = 0;
    let skipped = 0;
    let retry = 0;
    for (const r of rows) {
      let update: { width: number | null; height: number | null; variants: unknown[] } | null = null;
      if (!DERIVED_FOLDERS.has(r.path.split('/')[1] ?? '')) {
        skipped++;
      } else {
        let bytes: Buffer | null;
        try {
          bytes = await this.storage.read(r.path);
        } catch (e) {
          // Transient (5xx, 429, timeout): leave it unchecked so a later run retries it, after a cool-down.
          this.coolingDown.set(r.id, true);
          this.logger.warn(`media ${r.id}: read failed, will retry: ${(e as Error).message}`);
          retry++;
          continue;
        }
        const out = bytes ? await deriveImage(bytes).catch(() => null) : null;
        if (out && out.width === null) return { derived, skipped, retry, pending: rows.length - derived - skipped - retry }; // library unavailable: retry later
        if (out) {
          update = { width: out.width, height: out.height, variants: await this.storage.writeVariants(r.path, out.variants) };
          derived++;
        } else {
          skipped++; // missing (404) or undecodable object: marked checked so it is not retried forever
        }
      }
      await this.db.withPlatform((tx) => tx.query(
        `update media_assets set variants_checked_at = now(),
                variants = coalesce($2::jsonb, variants), width = coalesce($3, width), height = coalesce($4, height)
          where id = $1`, [r.id, update ? JSON.stringify(update.variants) : null, update?.width ?? null, update?.height ?? null]), 'media.derivatives');
    }
    if (derived) this.logger.log(`image derivatives produced for ${derived} object(s)`);
    return { derived, skipped, retry, pending: 0 };
  }
}
