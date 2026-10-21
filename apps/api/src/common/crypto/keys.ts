import { createHmac } from 'node:crypto';
import type { Env } from '../../config/env';

/** Purposes with their own derived key. Adding one never changes the keys of the others. */
export type KeyPurpose = 'media-url' | 'delivery-otp' | 'guest-token' | 'channel-unsubscribe';

export interface PurposeKeys {
  /** Signs everything new. */
  active: Buffer;
  /** Every key a value may have been signed with (active first): verification tries each. */
  all: Buffer[];
}

const DEV_MASTER = 'resuto-development-signing-key-not-for-deployed-environments';
const split = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const derive = (master: string, purpose: KeyPurpose) => createHmac('sha256', master).update(`resuto:key:${purpose}:v1`).digest();

/**
 * Purpose-bound server keys (audit PS-25, PS-08). Every HMAC the API computes uses a key derived for that purpose
 * only (HMAC-SHA256(master, "resuto:key:<purpose>:v1")), so a value signed for one purpose (a media URL, a delivery
 * code) can never stand in for another, and the Supabase JWT secret is never used to sign anything.
 *
 * Masters form a ring, newest first: the SIGNING_KEY entries (comma-separated), then every CREDENTIALS_KEYS entry.
 * The first is active; the others still verify. Rotating either setting the documented way (prepend the new key, drop
 * the old one later) therefore never invalidates outstanding delivery codes or media URLs, and setting SIGNING_KEY for
 * the first time keeps values signed under CREDENTIALS_KEYS valid. Outside deployed environments a fixed development
 * value is used when neither is configured.
 */
export function purposeKeys(env: Pick<Env, 'NODE_ENV' | 'SIGNING_KEY' | 'CREDENTIALS_KEYS'>, purpose: KeyPurpose): PurposeKeys {
  const masters = [...new Set([...split(env.SIGNING_KEY), ...split(env.CREDENTIALS_KEYS)])];
  if (!masters.length) {
    if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') {
      throw new Error(`No signing key material for ${purpose}: set SIGNING_KEY or CREDENTIALS_KEYS`);
    }
    masters.push(DEV_MASTER);
  }
  const all = masters.map((m) => derive(m, purpose));
  return { active: all[0]!, all };
}

/** The active key for a purpose (see purposeKeys). */
export function purposeKey(env: Pick<Env, 'NODE_ENV' | 'SIGNING_KEY' | 'CREDENTIALS_KEYS'>, purpose: KeyPurpose): Buffer {
  return purposeKeys(env, purpose).active;
}
