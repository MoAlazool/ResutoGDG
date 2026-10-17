// Deterministic identifiers for migrated rows.
import { createHash } from 'node:crypto';

/** RFC 4122 URL namespace; names are "resuto-legacy:<restaurantId>:<entity>:<legacyId>". */
export const NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

export function uuidv5(name, namespace = NAMESPACE) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const bytes = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export const legacyName = (restaurantId, entity, legacyId) => `resuto-legacy:${restaurantId}:${entity}:${legacyId}`;
export const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');
