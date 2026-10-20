// Input hygiene for webhook signatures and shared secrets (PAY-15).
//
// Signatures arrive as hex text in a header or the query string. Comparing the raw
// strings rejected valid upper-case hex and accepted values of any length; here the
// value must be exactly the expected number of hex digits, is decoded to bytes and
// compared with timingSafeEqual. Malformed input is rejected before any comparison.
import { createHash, timingSafeEqual } from 'node:crypto';

const HEX = /^[0-9a-fA-F]+$/;

/** True when `given` is a well-formed hex digest of `bytes` bytes equal to `expectedHex`. */
export function hexDigestEquals(expectedHex: string, given: unknown, bytes: number): boolean {
  if (!isHexDigest(given, bytes)) return false;
  const a = Buffer.from(expectedHex, 'hex');
  const b = Buffer.from(given.toLowerCase(), 'hex');
  return a.length === bytes && b.length === bytes && timingSafeEqual(a, b);
}

/** `value` is a string of exactly `bytes * 2` hex digits (either case). */
export function isHexDigest(value: unknown, bytes: number): value is string {
  return typeof value === 'string' && value.length === bytes * 2 && HEX.test(value);
}

/**
 * Constant-time comparison of two merchant-chosen secrets of arbitrary length
 * (Moyasar's webhook secret_token). Both sides are hashed first so neither the
 * content nor the length leaks through timing.
 */
export function secretEquals(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !given || !expected) return false;
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(given, 'utf8').digest();
  return timingSafeEqual(a, b) && expected.length === given.length;
}
