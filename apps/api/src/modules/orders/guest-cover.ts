import type { Tx } from '../../common/db/db.service';
import type { StorageService } from '../../common/storage/storage.service';

/** Long enough to outlive any cached guest page (table lookup 15 s, menus 30 s) and a long meal. */
const COVER_TTL_SECONDS = 6 * 3600;

/**
 * The restaurant's own cover photo for guest pages (QR table menu, website ordering): the hero image of its published
 * website (Studio theme), the same picture /r/<slug> shows. Null when the restaurant has not published one; the guest
 * cover then shows its plain brand-ink treatment, never another restaurant's photo (VP-07 review).
 * Runs inside the tenant; only a media asset of this organisation is ever returned.
 */
export async function guestCoverUrl(tx: Tx, orgId: string, storage: StorageService): Promise<string | null> {
  const path = await guestCoverPath(tx, orgId);
  return path ? storage.signedUrl(path, COVER_TTL_SECONDS) : null;
}

/** The cover's storage path (read inside a transaction; sign it afterwards with signGuestCover). */
export async function guestCoverPath(tx: Tx, orgId: string): Promise<string | null> {
  const row = await tx.maybeOne<{ path: string }>(
    `select ma.path
       from websites w
       join lateral (select r.snapshot from website_revisions r where r.website_id = w.id order by r.revision desc limit 1) rev on true
       join media_assets ma on ma.org_id = w.org_id and ma.id::text = rev.snapshot->'theme'->>'heroMediaId' and ma.content_type like 'image/%'
      where w.org_id = $1 and w.status = 'published'`, [orgId]);
  return row?.path ?? null;
}

export const signGuestCover = (storage: StorageService, path: string | null) => (path ? storage.signedUrl(path, COVER_TTL_SECONDS) : Promise.resolve(null));
