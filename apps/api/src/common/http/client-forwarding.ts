import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * Guest address forwarded by the web server (REM-A11). The Next.js server reads the restaurant, table and menu for
 * guest pages on the guests' behalf, so without this every server-side lookup counted against ONE rate-limit bucket
 * (the web server's egress address): one guest scanning QR codes could exhaust it for everyone. The web server now
 * sends the guest address with a signature made with a secret only the two servers share:
 *
 *   X-Resuto-Client-IP: 203.0.113.7
 *   X-Resuto-Forward-Sig: w=<10-minute window>,v1=<hex HMAC-SHA256(secret, "resuto-client-ip:v1:<w>:<ip>")>
 *
 * The API uses the address as req.ip (rate limits, access log) only when CLIENT_IP_FORWARD_SECRET is set, the
 * signature matches for the current or previous window, the address is a valid IP, and the request carries no Origin
 * header (browsers always send one on cross-origin calls; the server-to-server fetch does not). Anything else is
 * ignored, so a client cannot choose its own bucket by sending these headers. The window (not a per-request
 * timestamp) keeps the headers stable for ten minutes, so the web server's fetch cache still works per guest.
 */
export const FORWARD_IP_HEADER = 'x-resuto-client-ip';
export const FORWARD_SIG_HEADER = 'x-resuto-forward-sig';
export const FORWARD_WINDOW_SECONDS = 600;

const sign = (secret: string, window: number, ip: string) =>
  createHmac('sha256', secret).update(`resuto-client-ip:v1:${window}:${ip}`).digest('hex');

/** The signature header value for an address (used by tests; the web server has its own copy in components/guest/server.ts). */
export function forwardSignature(secret: string, ip: string, now = Date.now()): string {
  const w = Math.floor(now / 1000 / FORWARD_WINDOW_SECONDS);
  return `w=${w},v1=${sign(secret, w, ip)}`;
}

type HeaderBag = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/** The verified forwarded guest address, or null when the headers are absent, unsigned, stale, or not allowed here. */
export function forwardedClientIp(headers: HeaderBag, secret: string | undefined, now = Date.now()): string | null {
  if (!secret) return null;
  const ip = one(headers[FORWARD_IP_HEADER])?.trim();
  const sig = one(headers[FORWARD_SIG_HEADER])?.trim();
  if (!ip || !sig || ip.length > 45 || !isIP(ip)) return null;
  if (one(headers.origin)) return null;
  const m = /^w=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(sig);
  if (!m) return null;
  const w = Number(m[1]);
  const current = Math.floor(now / 1000 / FORWARD_WINDOW_SECONDS);
  if (w !== current && w !== current - 1) return null;
  const expected = Buffer.from(sign(secret, w, ip), 'hex');
  const given = Buffer.from(m[2]!, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given) ? ip : null;
}
