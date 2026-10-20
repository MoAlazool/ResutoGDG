import { createHmac } from 'node:crypto';
import { sha256 } from '../../common/crypto/hash';
import { purposeKeys } from '../../common/crypto/keys';
import type { Env } from '../../config/env';

/**
 * Guest bearer tokens for visits and reservation manage links.
 *
 * Visits — legacy behaviour is PIN-free: everyone who scans a table's physical
 * QR code joins that table's open visit, and `visits` stores exactly one
 * credential hash (`guest_token_hash`). The token is therefore *derived*:
 *
 *   token = base64url(HMAC-SHA256(guestTokenKey, "resuto:visit:v1:" + visitId))
 *
 * - Every scanner of the same physical QR receives the same per-visit token,
 *   and staff-seated visits get one too (a guest scanning later joins it).
 * - Only sha256(token) is persisted; the token itself is never stored, not even
 *   in idempotency replay records.
 * - It rotates on close: the next visit has a new id, and lookups only match
 *   open visits, so a closed visit's token stops working immediately.
 * - QR tokens are never accepted as bearer credentials and never returned by
 *   public endpoints (fixes CURRENT_STATE security issue 1). The printed QR is
 *   the physical proof of presence, exactly as in the legacy app.
 *
 * Reservations use the same construction with their own prefix, so the manage
 * link can be returned again on an idempotent retry without storing it.
 *
 * Keys (audit PS-25): the key is the `guest-token` purpose key (common/crypto/keys.ts), a ring derived from
 * SIGNING_KEY then CREDENTIALS_KEYS. New tokens use the newest key; a token is re-issued with whichever ring key
 * produced the hash already stored, so rotating either setting the documented way (prepend the new key) keeps every
 * table session and every reservation link that was already handed out working. The pre-ring derivation (first
 * CREDENTIALS_KEYS entry, else the JWT secret) stays in the ring as its last, verify-only member so links issued
 * before this change also survive; it is never used for new tokens and can be dropped once those reservations are past.
 */
export class GuestTokens {
  private readonly active: Buffer;
  private readonly ring: Buffer[];

  constructor(env: Env) {
    const keys = purposeKeys(env, 'guest-token');
    const legacyMaterial = env.CREDENTIALS_KEYS?.split(',')[0]?.trim() || env.SUPABASE_JWT_SECRET || 'resuto-dev-guest-token-key-not-for-production';
    const legacy = createHmac('sha256', 'resuto:guest-token-key:v1').update(legacyMaterial).digest();
    this.active = keys.active;
    this.ring = [...keys.all, legacy];
  }

  /** The visit token under the active key (new visits, or a visit whose stored hash no ring key reproduces). */
  tokenFor(visitId: string): string {
    return this.derive(this.active, 'visit', visitId);
  }

  hashFor(visitId: string): string {
    return sha256(this.tokenFor(visitId));
  }

  /** The visit token that matches the stored hash under any ring key, or null when none does (key retired). */
  visitTokenMatching(visitId: string, storedHash: string | null | undefined): string | null {
    return this.matching('visit', visitId, storedHash);
  }

  /**
   * The reservation manage token. With the stored hash, the ring token that produced it (null when no ring key
   * does); without it, the active-key token for a new reservation.
   */
  reservationToken(reservationId: string): string;
  reservationToken(reservationId: string, storedHash: string | null | undefined): string | null;
  reservationToken(reservationId: string, storedHash?: string | null): string | null {
    if (storedHash === undefined) return this.derive(this.active, 'reservation', reservationId);
    return this.matching('reservation', reservationId, storedHash);
  }

  private matching(kind: string, id: string, storedHash: string | null | undefined): string | null {
    if (!storedHash) return null;
    for (const key of this.ring) {
      const token = this.derive(key, kind, id);
      if (sha256(token) === storedHash) return token;
    }
    return null;
  }

  private derive(key: Buffer, kind: string, id: string) {
    return createHmac('sha256', key).update(`resuto:${kind}:v1:${id}`).digest('base64url');
  }
}
