import { Inject, Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ENV, type Env } from '../../config/env';

/**
 * AES-256-GCM envelope for provider credentials:
 *   v1:<keyId>:<iv b64>:<tag b64>:<ciphertext b64>
 * Keys rotate by prepending a new key to CREDENTIALS_KEYS; old keys still decrypt.
 * Without configured keys (local development only) a fixed dev key is used and
 * the envelope is marked keyId "dev" so it can never be mistaken for production.
 */
@Injectable()
export class SecretBox {
  private readonly keys = new Map<string, Buffer>();
  private readonly activeKeyId: string;

  constructor(@Inject(ENV) env: Env) {
    const entries = (env.CREDENTIALS_KEYS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    for (const entry of entries) {
      const [id, b64] = entry.split(':');
      const key = Buffer.from(b64 ?? '', 'base64');
      if (!id || key.length !== 32) throw new Error('CREDENTIALS_KEYS entries must be "<id>:<32-byte base64>"');
      this.keys.set(id, key);
    }
    if (this.keys.size === 0) this.keys.set('dev', Buffer.alloc(32, 7));
    this.activeKeyId = this.keys.keys().next().value as string;
  }

  seal(plaintext: string, aad = ''): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys.get(this.activeKeyId)!, iv);
    cipher.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return ['v1', this.activeKeyId, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
  }

  open(envelope: string, aad = ''): string {
    const [v, keyId, iv, tag, ct] = envelope.split(':');
    const key = keyId ? this.keys.get(keyId) : undefined;
    if (v !== 'v1' || !key || !iv || !tag || !ct) throw new Error('Unreadable credential envelope');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  }

  sealJson(value: unknown, aad = '') {
    return this.seal(JSON.stringify(value), aad);
  }
  openJson<T = Record<string, string>>(envelope: string, aad = ''): T {
    return JSON.parse(this.open(envelope, aad)) as T;
  }
}
