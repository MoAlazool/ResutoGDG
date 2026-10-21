// FT-22: Web Push. Encryption reproduces RFC 8291 §5 / Appendix A byte for byte; the VAPID JWT is verified with the
// public key; delivery is asserted against a scripted push service (nothing leaves the box).
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPushPayload, generateVapidKeys, sendWebPush, validatePushSubscription, validVapidKeys, vapidAuthorization } from './index';

const b = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  message: `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
            mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
            pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`,
};
const sub = (endpoint = 'https://fcm.googleapis.com/fcm/send/abc123') => ({ endpoint, keys: { p256dh: RFC.uaPublic, auth: RFC.auth } });

/** Receiver side (RFC 8291 §3.4) to prove a random-key message decrypts. */
function decrypt(body: Buffer, uaPrivate: string, uaPublic: string, auth: string) {
  const salt = body.subarray(0, 16);
  const idlen = body[20]!;
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(b(uaPrivate));
  const h = (k: Buffer, d: Buffer) => createHmac('sha256', k).update(d).digest();
  const ikm = h(h(b(auth), ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), b(uaPublic), asPublic, Buffer.from([1])]));
  const prk = h(salt, ikm);
  const cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const out = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  expect(out[out.length - 1]).toBe(2);
  return out.subarray(0, -1).toString('utf8');
}

describe('RFC 8291 encryption', () => {
  it('reproduces the RFC example byte for byte (fixed sender key and salt)', () => {
    const out = encryptPushPayload(sub(), Buffer.from(RFC.plaintext), { asPrivate: b(RFC.asPrivate), salt: b(RFC.salt) });
    expect(out.toString('base64url')).toBe(RFC.message.replace(/\s+/g, ''));
    // 86-octet header + 41-octet plaintext + delimiter + 16-octet tag. (The example's Content-Length line says 145; the body shown is 144 octets.)
    expect(out.length).toBe(144);
  });
  it('uses a fresh key and salt per message, and the receiver can decrypt it', () => {
    const a = encryptPushPayload(sub(), Buffer.from('{"kind":"offer"}'));
    const c = encryptPushPayload(sub(), Buffer.from('{"kind":"offer"}'));
    expect(a.subarray(0, 16).equals(c.subarray(0, 16))).toBe(false);
    expect(decrypt(a, RFC.uaPrivate, RFC.uaPublic, RFC.auth)).toBe('{"kind":"offer"}');
  });
});

describe('VAPID (RFC 8292)', () => {
  const keys = { ...generateVapidKeys(), subject: 'mailto:ops@resuto.example' };
  it('signs an ES256 JWT for the push service origin that verifies with the advertised key', () => {
    const header = vapidAuthorization('https://updates.push.services.mozilla.com/wpush/v2/gAAA', keys, 1_760_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header)!;
    expect(m[4]).toBe(keys.publicKey);
    expect(JSON.parse(Buffer.from(m[1]!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(JSON.parse(Buffer.from(m[2]!, 'base64url').toString())).toEqual({ aud: 'https://updates.push.services.mozilla.com', exp: 1_760_000_000 + 12 * 3600, sub: 'mailto:ops@resuto.example' });
    const pub = b(keys.publicKey);
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, b(m[3]!))).toBe(true);
  });
  it('validates key pairs and subjects', () => {
    expect(validVapidKeys(keys)).toBe(true);
    expect(validVapidKeys({ ...keys, subject: 'ops@resuto.example' })).toBe(false);
    expect(validVapidKeys({ ...keys, publicKey: generateVapidKeys().publicKey })).toBe(false);
    expect(validVapidKeys({ subject: keys.subject })).toBe(false);
  });
});

describe('subscriptions and delivery', () => {
  const keys = { ...generateVapidKeys(), subject: 'mailto:ops@resuto.example' };
  it('accepts only browser push services over https with well-formed keys', () => {
    expect(validatePushSubscription(sub()).ok).toBe(true);
    expect(validatePushSubscription(sub('https://web.push.apple.com/QGuQyavXutnMH'))).toMatchObject({ ok: true });
    expect(validatePushSubscription(sub('https://evil.example/fcm/send/x'))).toEqual({ ok: false, reason: 'unknown_push_service' });
    expect(validatePushSubscription(sub('http://fcm.googleapis.com/fcm/send/x'))).toEqual({ ok: false, reason: 'bad_endpoint' });
    expect(validatePushSubscription(sub('https://fcm.googleapis.com:8443/x'))).toEqual({ ok: false, reason: 'bad_endpoint' });
    expect(validatePushSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'AAAA', auth: RFC.auth } })).toEqual({ ok: false, reason: 'bad_keys' });
    expect(validatePushSubscription(null)).toEqual({ ok: false, reason: 'malformed' });
  });
  it('POSTs the encrypted body with VAPID, TTL and urgency; 410 means gone, 429/5xx are retryable', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const statuses = [201, 410, 429, 503];
    const f = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response('', { status: statuses.shift()!, headers: { location: 'https://fcm.googleapis.com/m/1' } }); }) as unknown as typeof fetch;
    expect(await sendWebPush(f, sub(), { kind: 'offer' }, keys, { ttlSeconds: 60 })).toEqual({ status: 'accepted', location: 'https://fcm.googleapis.com/m/1' });
    const h = calls[0]!.init.headers as Record<string, string>;
    expect(h).toMatchObject({ TTL: '60', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', Urgency: 'high' });
    expect(h.Authorization).toMatch(/^vapid t=.+, k=/);
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(decrypt(calls[0]!.init.body as Buffer, RFC.uaPrivate, RFC.uaPublic, RFC.auth)).toBe('{"kind":"offer"}');
    await expect(sendWebPush(f, sub(), {}, keys)).rejects.toMatchObject({ message: 'web_push: gone', retryable: false, status: 410 });
    await expect(sendWebPush(f, sub(), {}, keys)).rejects.toMatchObject({ retryable: true, status: 429 });
    await expect(sendWebPush(f, sub(), {}, keys)).rejects.toMatchObject({ retryable: true, status: 503 });
    await expect(sendWebPush(f, sub('https://evil.example/x'), {}, keys)).rejects.toMatchObject({ retryable: false });
    expect(calls).toHaveLength(4);
  });
});
