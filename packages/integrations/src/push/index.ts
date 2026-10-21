// Web Push (FT-22) for the driver PWA, with node:crypto only (no third-party library):
//   - RFC 8291 message encryption (aes128gcm content coding, RFC 8188), one record, padding delimiter 0x02.
//     https://www.rfc-editor.org/rfc/rfc8291 (Appendix A vector reproduced in push.test.ts)
//   - RFC 8292 VAPID: "Authorization: vapid t=<ES256 JWT>, k=<application server public key>", JWT claims
//     aud = origin of the push resource, exp ≤ 24 h, sub = mailto:/https: contact. https://www.rfc-editor.org/rfc/rfc8292
//   - RFC 8030 delivery: POST the encrypted body to the subscription endpoint with TTL (and Urgency); 201 = accepted
//     by the push service; 404 / 410 = the subscription is gone. https://www.rfc-editor.org/rfc/rfc8030
// Endpoints come from browsers, so only the push services browsers actually use are accepted (no SSRF through a
// forged subscription). No account or key is needed beyond the platform's VAPID key pair.
import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign as cryptoSign, type ECDH } from 'node:crypto';
import { ProviderError, type ProviderDescriptor } from '../core';

export interface PushSubscriptionJson { endpoint: string; expirationTime?: number | null; keys: { p256dh: string; auth: string } }
export interface VapidKeys { publicKey: string; privateKey: string; subject: string }

const b64u = (b: Buffer) => b.toString('base64url');
const fromB64u = (s: string) => Buffer.from(s.replace(/\s+/g, ''), 'base64url');
const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/**
 * Push services used by current browsers (Chrome/Edge/Android → FCM, Firefox → Mozilla autopush, Safari → Apple,
 * Edge legacy → WNS). Anything else is refused before any request is made.
 */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/,
  /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/];

export function validatePushSubscription(input: unknown): { ok: true; subscription: PushSubscriptionJson } | { ok: false; reason: string } {
  const s = input as PushSubscriptionJson;
  if (!s || typeof s !== 'object' || typeof s.endpoint !== 'string' || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') {
    return { ok: false, reason: 'malformed' };
  }
  let url: URL;
  try { url = new URL(s.endpoint); } catch { return { ok: false, reason: 'bad_endpoint' }; }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || s.endpoint.length > 1024) return { ok: false, reason: 'bad_endpoint' };
  if (!PUSH_HOSTS.some((h) => h.test(url.hostname))) return { ok: false, reason: 'unknown_push_service' };
  const p256dh = fromB64u(s.keys.p256dh);
  const auth = fromB64u(s.keys.auth);
  if (p256dh.length !== 65 || p256dh[0] !== 0x04 || auth.length !== 16) return { ok: false, reason: 'bad_keys' };
  return { ok: true, subscription: { endpoint: s.endpoint, expirationTime: s.expirationTime ?? null, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } } };
}

/** Generates a VAPID key pair (raw uncompressed public key, raw private scalar; both base64url). */
export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

export function validVapidKeys(k: Partial<VapidKeys>): k is VapidKeys {
  try {
    if (!k.publicKey || !k.privateKey || !k.subject || !/^(mailto:\S+@\S+|https:\/\/\S+)$/.test(k.subject)) return false;
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(fromB64u(k.privateKey));
    return b64u(ecdh.getPublicKey()) === k.publicKey.replace(/=+$/, '');
  } catch {
    return false;
  }
}

/** RFC 8292 Authorization header value for one push resource. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = 12 * 3600): string {
  const pub = fromB64u(keys.publicKey);
  if (pub.length !== 65) throw new ProviderError('web_push', 'invalid VAPID public key', false);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)), d: keys.privateKey.replace(/=+$/, '') };
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowSeconds + Math.min(ttlSeconds, 24 * 3600), sub: keys.subject })));
  const signature = cryptoSign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${b64u(pub)}`;
}

/**
 * RFC 8291 encryption of one message (≤ 3993 bytes of plaintext so the single record fits 4096). `asPrivate` and
 * `salt` are only passed by tests (RFC vector); production uses a fresh key pair and salt per message.
 */
export function encryptPushPayload(subscription: PushSubscriptionJson, plaintext: Buffer, opts: { asPrivate?: Buffer; salt?: Buffer } = {}): Buffer {
  if (plaintext.length > 3993) throw new ProviderError('web_push', 'payload too large', false);
  const uaPublic = fromB64u(subscription.keys.p256dh);
  const authSecret = fromB64u(subscription.keys.auth);
  const ecdh: ECDH = createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const salt = opts.salt ?? randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm\0'), Buffer.from([1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from('Content-Encoding: nonce\0'), Buffer.from([1])])).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

export type PushUrgency = 'very-low' | 'low' | 'normal' | 'high';
export interface PushSendResult { status: 'accepted'; location: string | null }

/**
 * Sends one notification. Throws ProviderError: `gone` (404/410, the subscription must be deleted) is not retryable,
 * 429/5xx are. Never follows redirects.
 */
export async function sendWebPush(fetchImpl: typeof fetch, subscription: PushSubscriptionJson, payload: Record<string, unknown>, keys: VapidKeys,
  opts: { ttlSeconds?: number; urgency?: PushUrgency; topic?: string } = {}): Promise<PushSendResult> {
  const v = validatePushSubscription(subscription);
  if (!v.ok) throw new ProviderError('web_push', `subscription refused (${v.reason})`, false);
  const body = encryptPushPayload(subscription, Buffer.from(JSON.stringify(payload)));
  const headers: Record<string, string> = {
    TTL: String(opts.ttlSeconds ?? 300), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
    Authorization: vapidAuthorization(subscription.endpoint, keys), Urgency: opts.urgency ?? 'high',
  };
  if (opts.topic && /^[A-Za-z0-9_-]{1,32}$/.test(opts.topic)) headers.Topic = opts.topic;
  let res: Response;
  try {
    res = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new ProviderError('web_push', `network error (${(e as Error).name})`, true);
  }
  await res.text().catch(() => '');
  if (res.status === 201 || res.status === 200 || res.status === 202) return { status: 'accepted', location: res.headers.get('location') };
  if (res.status === 404 || res.status === 410) throw new ProviderError('web_push', 'gone', false, res.status);
  const retryAfter = Number(res.headers.get('retry-after'));
  throw new ProviderError('web_push', `HTTP ${res.status}`, res.status === 429 || res.status >= 500, res.status,
    Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined);
}

export const webPushDescriptor: ProviderDescriptor = {
  id: 'web_push', name: 'Web Push (driver app)', category: 'messaging', countries: ['EG', 'SA'], authType: 'none', readiness: 'implemented_unverified',
  docsUrl: 'https://www.rfc-editor.org/rfc/rfc8030',
  capabilities: ['push_notification'],
  activation: [
    'Platform setting (no restaurant account): generate one VAPID key pair per environment and set WEB_PUSH_VAPID_PUBLIC_KEY, WEB_PUSH_VAPID_PRIVATE_KEY and WEB_PUSH_SUBJECT (mailto: contact) on the API.',
    'Drivers open the driver app, tap "Turn on notifications" and allow notifications in the browser. On iPhone the app must first be added to the Home Screen (iOS 16.4+).',
    'Drivers are notified of new offers, assignments and cancellations; the app still works (polling) without notifications.',
  ],
};
