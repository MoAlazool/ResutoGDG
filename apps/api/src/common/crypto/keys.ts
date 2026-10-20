import { createHmac } from 'node:crypto';
import type { Env } from '../../config/env';

/** Purposes with their own derived key. Adding one never changes the keys of the others. */
export type KeyPurpose = 'media-url' | 'delivery-otp';

/**
 * Purpose-bound server keys (audit PS-25, PS-08). Every HMAC the API computes uses a key derived for that purpose
 * only (HMAC-SHA256(master, "resuto:key:<purpose>:v1")), so a value signed for one purpose (a media URL, a delivery
 * code) can never stand in for another, and the Supabase JWT secret is never used to sign anything.
 *
 * Master: SIGNING_KEY when set, otherwise the active CREDENTIALS_KEYS entry (required in staging/production). Outside
 * deployed environments a fixed development value is used when neither is configured.
 */
export function purposeKey(env: Pick<Env, 'NODE_ENV' | 'SIGNING_KEY' | 'CREDENTIALS_KEYS'>, purpose: KeyPurpose): Buffer {
  const master = env.SIGNING_KEY || env.CREDENTIALS_KEYS?.split(',')[0]?.trim();
  if (!master && (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging')) {
    throw new Error(`No signing key material for ${purpose}: set SIGNING_KEY or CREDENTIALS_KEYS`);
  }
  return createHmac('sha256', master || 'resuto-development-signing-key-not-for-deployed-environments')
    .update(`resuto:key:${purpose}:v1`).digest();
}
