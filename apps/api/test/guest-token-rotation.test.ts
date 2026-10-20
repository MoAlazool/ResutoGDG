import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256 } from '../src/common/crypto/hash';
import { purposeKey } from '../src/common/crypto/keys';
import type { Env } from '../src/config/env';
import { GuestTokens } from '../src/modules/orders/guest-tokens';

// PS-25 follow-up: visit and reservation tokens were derived from CREDENTIALS_KEYS[0] (or the JWT secret), so
// rotating CREDENTIALS_KEYS the documented way re-derived every token: re-issued reservation links no longer matched
// the stored hash and every guest at a table was logged out on the next scan.

const K1 = 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const K2 = 'k2:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const S1 = 'signing-key-one-0123456789abcdefghijklmnop';
const env = (o: Partial<Env>) => ({ NODE_ENV: 'test', ...o }) as Env;
const VISIT = '0b5f0d2e-5c1a-4b7e-9a51-3f1e2d4c5b6a';
const RES = '7d3a9c1e-2b4f-4e6a-8c0d-1a2b3c4d5e6f';

/** The derivation used before the purpose-key ring (kept verify-only). */
const legacyToken = (material: string, kind: string, id: string) => {
  const key = createHmac('sha256', 'resuto:guest-token-key:v1').update(material).digest();
  return createHmac('sha256', key).update(`resuto:${kind}:v1:${id}`).digest('base64url');
};

describe('guest tokens use the guest-token purpose key ring', () => {
  it('new tokens come from the active guest-token purpose key, never from another purpose', () => {
    const t = new GuestTokens(env({ CREDENTIALS_KEYS: K1 }));
    const expected = createHmac('sha256', purposeKey(env({ CREDENTIALS_KEYS: K1 }), 'guest-token')).update(`resuto:visit:v1:${VISIT}`).digest('base64url');
    expect(t.tokenFor(VISIT)).toBe(expected);
    const media = createHmac('sha256', purposeKey(env({ CREDENTIALS_KEYS: K1 }), 'media-url')).update(`resuto:visit:v1:${VISIT}`).digest('base64url');
    expect(t.tokenFor(VISIT)).not.toBe(media);
    expect(t.hashFor(VISIT)).toBe(sha256(expected));
  });

  it('a reservation link issued before CREDENTIALS_KEYS rotation is re-issued unchanged after it', () => {
    const before = new GuestTokens(env({ CREDENTIALS_KEYS: K1 }));
    const link = before.reservationToken(RES);
    const stored = sha256(link);
    const rotated = new GuestTokens(env({ CREDENTIALS_KEYS: `${K2},${K1}` }));
    expect(rotated.reservationToken(RES, stored)).toBe(link);
    expect(rotated.reservationToken(RES)).not.toBe(link); // new reservations use the new key
    // Introducing SIGNING_KEY later keeps it too.
    expect(new GuestTokens(env({ SIGNING_KEY: S1, CREDENTIALS_KEYS: `${K2},${K1}` })).reservationToken(RES, stored)).toBe(link);
  });

  it('a table session keeps its token across rotation; a retired key yields no match', () => {
    const before = new GuestTokens(env({ CREDENTIALS_KEYS: K1 }));
    const stored = before.hashFor(VISIT);
    expect(new GuestTokens(env({ CREDENTIALS_KEYS: `${K2},${K1}` })).visitTokenMatching(VISIT, stored)).toBe(before.tokenFor(VISIT));
    expect(new GuestTokens(env({ CREDENTIALS_KEYS: K2 })).visitTokenMatching(VISIT, stored)).toBeNull();
    expect(new GuestTokens(env({ CREDENTIALS_KEYS: K2 })).visitTokenMatching(VISIT, null)).toBeNull();
  });

  it('links issued by the pre-ring derivation (first CREDENTIALS_KEYS entry, else the JWT secret) still match', () => {
    const oldLink = legacyToken(K1, 'reservation', RES);
    expect(new GuestTokens(env({ CREDENTIALS_KEYS: K1 })).reservationToken(RES, sha256(oldLink))).toBe(oldLink);
    const jwt = 'jwt-secret-that-is-at-least-32-characters-long';
    const oldVisit = legacyToken(jwt, 'visit', VISIT);
    expect(new GuestTokens(env({ SUPABASE_JWT_SECRET: jwt })).visitTokenMatching(VISIT, sha256(oldVisit))).toBe(oldVisit);
    // ...but they are never minted any more.
    expect(new GuestTokens(env({ CREDENTIALS_KEYS: K1 })).reservationToken(RES)).not.toBe(oldLink);
  });
});
