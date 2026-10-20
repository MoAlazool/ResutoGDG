import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ENV, type Env } from '../../config/env';
import type { TenantContext } from '../auth/context';
import { safeEqual } from '../crypto/hash';
import { purposeKeys, type PurposeKeys } from '../crypto/keys';
import type { Tx } from '../db/db.service';
import { invalid } from '../errors/domain-error';
import { BoundedCache } from '../cache/bounded-cache';
import { deriveImage, derivable, pickVariant, variantObjectPath, type MediaVariant } from './image-variants';

const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf']);
const MAX_BYTES = 15 * 1024 * 1024;
const MAGIC: Array<[string, (b: Buffer) => boolean]> = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP'],
  ['image/gif', (b) => b.subarray(0, 3).toString() === 'GIF'],
  ['application/pdf', (b) => b.subarray(0, 5).toString() === '%PDF-'],
];

export interface StoredMedia {
  id: string;
  path: string;
  contentType: string;
  byteSize: number;
  width?: number | null;
  height?: number | null;
  variants?: MediaVariant[];
}

/** An object written to storage but not yet recorded in media_assets (see StorageService.store / record). */
export interface StoredObject {
  path: string;
  contentType: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  variants: MediaVariant[];
  /** False when derivatives are still owed (the image library was unavailable): the backfill job retries. */
  checked: boolean;
}

/**
 * Signed URLs are stable within a window (PCL-14): the expiry is rounded up to a window boundary, so every request in
 * the same window gets the same URL and browsers / CDNs can reuse the download. A URL is valid for at least `ttl`
 * and at most 2 x ttl seconds. For the 24-hour menu TTL the URL changes once per UTC day.
 */
export function stableExpiry(ttlSeconds: number, nowMs = Date.now()) {
  const window = Math.max(60, Math.floor(ttlSeconds));
  return (Math.floor(nowMs / 1000 / window) + 2) * window;
}

/** Folders whose objects are guest-facing images (public cache headers); everything else is private documents. */
const PUBLIC_FOLDERS = new Set(['menu', 'studio']);
export function isPublicMediaPath(objectPath: string) {
  return PUBLIC_FOLDERS.has(objectPath.split('/')[1] ?? '');
}

/**
 * Collects the media URLs a response needs and signs them in one batch (PS-18) once `resolve()` is called, normally
 * after the database transaction has committed (PCL-11: no storage round-trip while a pooled connection is held).
 * `set` writes the fallback immediately, so an unresolved collector still yields a well-formed object.
 */
export class MediaUrls {
  private readonly pending: Array<{ target: any; key: string; path: string; srcSetKey?: string; variants?: MediaVariant[] }> = [];

  constructor(private readonly storage: StorageService, private readonly ttlSeconds: number) {}

  /**
   * target[key] = signed URL of the original, or of the smallest derivative at least `minWidth` wide. With `srcSetKey`
   * also target[srcSetKey] = "url 320w, url 640w, ..." over the derivatives (null without derivatives).
   */
  set<T extends object>(target: T, key: keyof T & string, path: string | null | undefined, opts: {
    fallback?: string | null; variants?: MediaVariant[] | null; minWidth?: number; srcSetKey?: keyof T & string;
  } = {}): T {
    (target as any)[key] = path ? null : opts.fallback ?? null;
    if (opts.srcSetKey) (target as any)[opts.srcSetKey] = null;
    if (path) {
      const chosen = opts.minWidth ? pickVariant(path, opts.variants, opts.minWidth) : path;
      this.pending.push({ target, key, path: chosen, srcSetKey: opts.srcSetKey, variants: opts.variants ?? undefined });
    }
    return target;
  }

  /** Signs every collected path in one call. Paths that cannot be signed resolve to null (the image is omitted). */
  async resolve(): Promise<void> {
    if (!this.pending.length) return;
    const paths = new Set<string>();
    for (const p of this.pending) {
      paths.add(p.path);
      if (p.srcSetKey) for (const v of p.variants ?? []) paths.add(v.path);
    }
    const urls = await this.storage.signedUrls([...paths], this.ttlSeconds);
    for (const p of this.pending.splice(0)) {
      p.target[p.key] = urls.get(p.path) ?? null;
      if (p.srcSetKey) {
        const parts = [...(p.variants ?? [])].sort((a, b) => a.w - b.w)
          .map((v) => (urls.get(v.path) ? `${urls.get(v.path)} ${v.w}w` : null)).filter(Boolean);
        p.target[p.srcSetKey] = parts.length ? parts.join(', ') : null;
      }
    }
  }
}

/**
 * Tenant media storage. Objects are always under "<org_id>/" in the private
 * "tenant-media" bucket. Driver "supabase" uses Supabase Storage with the
 * service-role key (server side only); driver "local" writes to disk for
 * development. Clients only ever receive signed URLs; they are stable within an expiry window (stableExpiry) and
 * signed in batches (MediaUrls), outside database transactions where the caller allows it.
 */
@Injectable()
export class StorageService {
  private readonly bucket = 'tenant-media';
  /** Signs local-driver media URLs; its own derived key ring, never the JWT secret (audit PS-25). */
  private readonly signingKeys: PurposeKeys;
  /** Supabase-signed URLs per path and expiry window (bounded, PCL-25): repeat reads in a window need no round-trip. */
  private readonly signed = new BoundedCache<string>(20_000, 3600_000);

  constructor(@Inject(ENV) private readonly env: Env) {
    this.signingKeys = purposeKeys(env, 'media-url');
    if (env.STORAGE_DRIVER === 'supabase' && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)) {
      throw new Error('STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    }
  }

  /** Validates by magic bytes (never trusts the declared type), stores, and records media_assets. */
  async put(tx: Tx, ctx: TenantContext, input: { bytes: Buffer; contentType: string; folder: string; source?: string; alt?: string }): Promise<StoredMedia> {
    const stored = await this.store(ctx, input);
    return this.record(tx, ctx, stored, input);
  }

  /**
   * Phase 1 of an upload, outside any transaction (PCL-11): validates, writes the original and, for guest-facing
   * images, the WebP derivatives (CR-12). Object keys are random and never overwritten, so every URL is immutable.
   * If the transaction that records it fails, the object is orphaned (unreferenced, never served).
   */
  async store(ctx: TenantContext, input: { bytes: Buffer; contentType: string; folder: string }): Promise<StoredObject> {
    if (!ALLOWED.has(input.contentType)) throw invalid('unsupported_media', 'Upload a PNG, JPEG, WebP, GIF or PDF file');
    if (input.bytes.length === 0 || input.bytes.length > MAX_BYTES) throw invalid('media_too_large', 'Files must be under 15 MB');
    const detected = MAGIC.find(([, test]) => test(input.bytes))?.[0];
    if (detected !== input.contentType) throw invalid('media_type_mismatch', 'The file contents do not match its type');
    if (!/^[a-z0-9-]{1,40}$/.test(input.folder)) throw new Error('invalid storage folder');
    const ext = input.contentType.split('/')[1]!.replace('jpeg', 'jpg');
    const objectPath = `${ctx.orgId}/${input.folder}/${randomUUID()}.${ext}`;
    const wanted = derivable(input.contentType, input.folder);
    const derived = wanted
      ? await deriveImage(input.bytes).catch(() => { throw invalid('unreadable_image', 'The image could not be read'); })
      : { width: null, height: null, variants: [] };
    await this.write(objectPath, input.bytes, input.contentType);
    const variants: MediaVariant[] = [];
    for (const v of derived.variants) {
      const path = variantObjectPath(objectPath, v.w);
      await this.write(path, v.bytes, 'image/webp');
      variants.push({ w: v.w, h: v.h, path, bytes: v.bytes.length });
    }
    return { path: objectPath, contentType: input.contentType, byteSize: input.bytes.length, width: derived.width, height: derived.height, variants,
      checked: !wanted || derived.width !== null };
  }

  /** Phase 2 of an upload, inside the caller's transaction: records the stored object in media_assets. */
  async record(tx: Tx, ctx: TenantContext, stored: StoredObject, meta: { source?: string; alt?: string } = {}): Promise<StoredMedia> {
    const row = await tx.one<{ id: string }>(
      `insert into media_assets(org_id, bucket, path, content_type, byte_size, width, height, variants, variants_checked_at, source, alt, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, case when $9 then now() end, $10, $11, $12) returning id`,
      [ctx.orgId, this.bucket, stored.path, stored.contentType, stored.byteSize, stored.width, stored.height, JSON.stringify(stored.variants),
        stored.checked, meta.source ?? 'upload', meta.alt ?? null, ctx.userId]);
    return { id: row.id, path: stored.path, contentType: stored.contentType, byteSize: stored.byteSize, width: stored.width, height: stored.height,
      variants: stored.variants };
  }

  /** A collector that signs every URL of a response in one batch; call `resolve()` after the transaction. */
  urls(ttlSeconds = 3600) {
    return new MediaUrls(this, ttlSeconds);
  }

  async signedUrl(objectPath: string, ttlSeconds = 3600): Promise<string> {
    const url = (await this.signedUrls([objectPath], ttlSeconds, { strict: true })).get(objectPath);
    if (!url) throw new Error('Storage sign failed');
    return url;
  }

  /**
   * Signs many objects at once with a window-stable expiry (stableExpiry). Local driver: HMAC, no I/O. Supabase: one
   * POST /object/sign/<bucket> for all paths not already cached for this window. Failures map to a missing entry
   * (or throw with `strict`).
   */
  async signedUrls(paths: string[], ttlSeconds = 3600, opts: { strict?: boolean } = {}): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const unique = [...new Set(paths.filter(Boolean))];
    if (!unique.length) return out;
    const exp = stableExpiry(ttlSeconds);
    if (this.env.STORAGE_DRIVER !== 'supabase') {
      for (const p of unique) out.set(p, `${this.env.API_ORIGIN}/v1/media/${encodeURIComponent(p)}?exp=${exp}&sig=${this.sign(`${p}:${exp}`)}`);
      return out;
    }
    const missing: string[] = [];
    for (const p of unique) {
      const hit = this.signed.get(`${exp}|${p}`);
      if (hit) out.set(p, hit); else missing.push(p);
    }
    for (let i = 0; i < missing.length; i += 500) {
      const chunk = missing.slice(i, i + 500);
      try {
        const res = await fetch(`${this.env.SUPABASE_URL}/storage/v1/object/sign/${this.bucket}`, {
          method: 'POST',
          headers: { ...this.serviceAuth(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ expiresIn: Math.max(60, exp - Math.floor(Date.now() / 1000)), paths: chunk }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`Storage sign failed: ${res.status}`);
        const rows = (await res.json()) as Array<{ path: string | null; signedURL: string | null; error: string | null }>;
        for (const r of rows) {
          if (!r.path || !r.signedURL) continue;
          const url = `${this.env.SUPABASE_URL}/storage/v1${r.signedURL}`;
          out.set(r.path, url);
          // Kept until a minute before it expires (and never past the window it was signed for).
          this.signed.set(`${exp}|${r.path}`, url, Math.max(0, (exp - 60) * 1000 - Date.now()));
        }
      } catch (e) {
        if (opts.strict) throw e;
      }
    }
    return out;
  }

  /** Reads an object's bytes server side (derivative backfill). */
  async read(objectPath: string): Promise<Buffer | null> {
    if (objectPath.includes('..')) return null;
    if (this.env.STORAGE_DRIVER === 'supabase') {
      const res = await fetch(`${this.env.SUPABASE_URL}/storage/v1/object/${this.bucket}/${objectPath}`, {
        headers: this.serviceAuth(), signal: AbortSignal.timeout(30_000) });
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    }
    return readFile(path.join(this.env.STORAGE_LOCAL_DIR, this.bucket, objectPath)).catch(() => null);
  }

  /** Writes derivatives for an object already recorded (backfill job). */
  async writeVariants(objectPath: string, variants: Array<{ w: number; h: number; bytes: Buffer }>): Promise<MediaVariant[]> {
    const out: MediaVariant[] = [];
    for (const v of variants) {
      const p = variantObjectPath(objectPath, v.w);
      await this.write(p, v.bytes, 'image/webp', { overwrite: true });
      out.push({ w: v.w, h: v.h, path: p, bytes: v.bytes.length });
    }
    return out;
  }

  /** Local driver only: verifies a signed URL and returns the bytes. */
  async readSigned(objectPath: string, exp: number, sig: string): Promise<Buffer | null> {
    if (this.env.STORAGE_DRIVER !== 'local') return null;
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return null;
    if (!this.signingKeys.all.reduce((ok, key) => safeEqual(this.sign(`${objectPath}:${exp}`, key), sig) || ok, false)) return null;
    if (objectPath.includes('..')) return null;
    return readFile(path.join(this.env.STORAGE_LOCAL_DIR, this.bucket, objectPath)).catch(() => null);
  }

  /** Legacy service_role keys are JWTs (Authorization); new `sb_secret_` keys go in the apikey header only. */
  private serviceAuth(): Record<string, string> {
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    return key.split('.').length === 3 ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
  }

  private sign(value: string, key: Buffer = this.signingKeys.active) {
    return createHmac('sha256', key).update(value).digest('base64url');
  }

  private async write(objectPath: string, bytes: Buffer, contentType: string, opts: { overwrite?: boolean } = {}) {
    if (this.env.STORAGE_DRIVER === 'supabase') {
      // Keys are never reused, so the object is immutable: let Storage/CDN cache guest-facing images for a year.
      const cache: Record<string, string> = isPublicMediaPath(objectPath) ? { 'cache-control': 'max-age=31536000' } : {};
      const res = await fetch(`${this.env.SUPABASE_URL}/storage/v1/object/${this.bucket}/${objectPath}`, {
        method: 'POST',
        headers: { ...this.serviceAuth(), 'Content-Type': contentType, 'x-upsert': opts.overwrite ? 'true' : 'false', ...cache },
        body: new Uint8Array(bytes),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`Storage upload failed: ${res.status}`);
      return;
    }
    const file = path.join(this.env.STORAGE_LOCAL_DIR, this.bucket, objectPath);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
}
