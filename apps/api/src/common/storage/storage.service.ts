import { Inject, Injectable } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ENV, type Env } from '../../config/env';
import type { TenantContext } from '../auth/context';
import { safeEqual } from '../crypto/hash';
import { purposeKey } from '../crypto/keys';
import type { Tx } from '../db/db.service';
import { invalid } from '../errors/domain-error';

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
}

/**
 * Tenant media storage. Objects are always under "<org_id>/" in the private
 * "tenant-media" bucket. Driver "supabase" uses Supabase Storage with the
 * service-role key (server side only); driver "local" writes to disk for
 * development. Clients only ever receive short-lived signed URLs.
 */
@Injectable()
export class StorageService {
  private readonly bucket = 'tenant-media';
  /** Signs local-driver media URLs; its own derived key, never the JWT secret (audit PS-25). */
  private readonly signingKey: Buffer;

  constructor(@Inject(ENV) private readonly env: Env) {
    this.signingKey = purposeKey(env, 'media-url');
    if (env.STORAGE_DRIVER === 'supabase' && (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY)) {
      throw new Error('STORAGE_DRIVER=supabase requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    }
  }

  /** Validates by magic bytes (never trusts the declared type), stores, and records media_assets. */
  async put(tx: Tx, ctx: TenantContext, input: { bytes: Buffer; contentType: string; folder: string; source?: string; alt?: string }): Promise<StoredMedia> {
    if (!ALLOWED.has(input.contentType)) throw invalid('unsupported_media', 'Upload a PNG, JPEG, WebP, GIF or PDF file');
    if (input.bytes.length === 0 || input.bytes.length > MAX_BYTES) throw invalid('media_too_large', 'Files must be under 15 MB');
    const detected = MAGIC.find(([, test]) => test(input.bytes))?.[0];
    if (detected !== input.contentType) throw invalid('media_type_mismatch', 'The file contents do not match its type');
    if (!/^[a-z0-9-]{1,40}$/.test(input.folder)) throw new Error('invalid storage folder');
    const ext = input.contentType.split('/')[1]!.replace('jpeg', 'jpg');
    const objectPath = `${ctx.orgId}/${input.folder}/${randomUUID()}.${ext}`;
    await this.write(objectPath, input.bytes, input.contentType);
    const row = await tx.one<{ id: string }>(
      `insert into media_assets(org_id, bucket, path, content_type, byte_size, source, alt, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [ctx.orgId, this.bucket, objectPath, input.contentType, input.bytes.length, input.source ?? 'upload', input.alt ?? null, ctx.userId]);
    return { id: row.id, path: objectPath, contentType: input.contentType, byteSize: input.bytes.length };
  }

  async signedUrl(objectPath: string, ttlSeconds = 3600): Promise<string> {
    if (this.env.STORAGE_DRIVER === 'supabase') {
      const res = await fetch(`${this.env.SUPABASE_URL}/storage/v1/object/sign/${this.bucket}/${objectPath}`, {
        method: 'POST',
        headers: { ...this.serviceAuth(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: ttlSeconds }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Storage sign failed: ${res.status}`);
      const { signedURL } = (await res.json()) as { signedURL: string };
      return `${this.env.SUPABASE_URL}/storage/v1${signedURL}`;
    }
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = this.sign(`${objectPath}:${exp}`);
    return `${this.env.API_ORIGIN}/v1/media/${encodeURIComponent(objectPath)}?exp=${exp}&sig=${sig}`;
  }

  /** Local driver only: verifies a signed URL and returns the bytes. */
  async readSigned(objectPath: string, exp: number, sig: string): Promise<Buffer | null> {
    if (this.env.STORAGE_DRIVER !== 'local') return null;
    if (!Number.isFinite(exp) || exp < Date.now() / 1000) return null;
    if (!safeEqual(this.sign(`${objectPath}:${exp}`), sig)) return null;
    if (objectPath.includes('..')) return null;
    return readFile(path.join(this.env.STORAGE_LOCAL_DIR, this.bucket, objectPath)).catch(() => null);
  }

  /** Legacy service_role keys are JWTs (Authorization); new `sb_secret_` keys go in the apikey header only. */
  private serviceAuth(): Record<string, string> {
    const key = this.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
    return key.split('.').length === 3 ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
  }

  private sign(value: string) {
    return createHmac('sha256', this.signingKey).update(value).digest('base64url');
  }

  private async write(objectPath: string, bytes: Buffer, contentType: string) {
    if (this.env.STORAGE_DRIVER === 'supabase') {
      const res = await fetch(`${this.env.SUPABASE_URL}/storage/v1/object/${this.bucket}/${objectPath}`, {
        method: 'POST',
        headers: { ...this.serviceAuth(), 'Content-Type': contentType, 'x-upsert': 'false' },
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
