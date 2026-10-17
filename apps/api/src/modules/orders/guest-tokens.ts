import { createHmac } from 'node:crypto';
import { sha256 } from '../../common/crypto/hash';
import type { Env } from '../../config/env';

/**
 * Guest bearer tokens for visits and reservation manage links.
 *
 * Visits — legacy behaviour is PIN-free: everyone who scans a table's physical
 * QR code joins that table's open visit, and `visits` stores exactly one
 * credential hash (`guest_token_hash`). The token is therefore *derived*:
 *
 *   token = base64url(HMAC-SHA256(serverKey, "resuto:visit:v1:" + visitId))
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
 * - If the server key rotates, the next scan re-hashes the open visit's token
 *   (old copies stop working; guests simply rescan).
 *
 * Reservations use the same construction with their own prefix, so the manage
 * link can be returned again on an idempotent retry without storing it.
 */
export class GuestTokens {
  private readonly key: Buffer;

  constructor(env: Env) {
    const material = env.CREDENTIALS_KEYS?.split(',')[0]?.trim() || env.SUPABASE_JWT_SECRET || 'resuto-dev-guest-token-key-not-for-production';
    this.key = createHmac('sha256', 'resuto:guest-token-key:v1').update(material).digest();
  }

  tokenFor(visitId: string): string {
    return this.derive('visit', visitId);
  }

  hashFor(visitId: string): string {
    return sha256(this.tokenFor(visitId));
  }

  reservationToken(reservationId: string): string {
    return this.derive('reservation', reservationId);
  }

  private derive(kind: string, id: string) {
    return createHmac('sha256', this.key).update(`resuto:${kind}:v1:${id}`).digest('base64url');
  }
}
