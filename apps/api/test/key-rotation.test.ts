import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { purposeKey, purposeKeys } from '../src/common/crypto/keys';
import { StorageService } from '../src/common/storage/storage.service';
import { envSchema, type Env } from '../src/config/env';
import { DeliveryService } from '../src/modules/delivery/delivery.service';

// Review finding (PS-25): purpose keys came from CREDENTIALS_KEYS[0] (or SIGNING_KEY) alone, so rotating keys the
// documented way (prepend a new CREDENTIALS_KEYS entry) changed the delivery-code key: every outstanding code then
// failed as otp_invalid and counted toward the 5-attempt lock, and signed media URLs stopped working.

const K1 = 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const K2 = 'k2:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const S1 = 'signing-key-one-0123456789abcdefghijklmnop';
const S2 = 'signing-key-two-0123456789abcdefghijklmnop';
const env = (o: Partial<Env>) => ({ NODE_ENV: 'test', ...o }) as Env;
const delivery = (e: Env) => new DeliveryService(null as any, null as any, null as any, null as any, null as any, e);
const JOB = '6f1c2f4e-8a59-4f9b-9d0e-1f2a3b4c5d6e';

describe('purpose key ring', () => {
  it('signs with the newest key and verifies with every key of both settings', () => {
    const ring = purposeKeys(env({ SIGNING_KEY: `${S2},${S1}`, CREDENTIALS_KEYS: `${K2},${K1}` }), 'delivery-otp');
    expect(ring.all).toHaveLength(4);
    expect(ring.active.equals(purposeKey(env({ SIGNING_KEY: S2 }), 'delivery-otp'))).toBe(true);
    expect(ring.all.some((k) => k.equals(purposeKey(env({ CREDENTIALS_KEYS: K1 }), 'delivery-otp')))).toBe(true);
    // purposes stay separate
    expect(purposeKey(env({ CREDENTIALS_KEYS: K1 }), 'media-url').equals(purposeKey(env({ CREDENTIALS_KEYS: K1 }), 'delivery-otp'))).toBe(false);
  });

  it('deployed environments refuse to run without key material; SIGNING_KEY entries must be long', () => {
    expect(() => purposeKeys(env({ NODE_ENV: 'staging' }), 'media-url')).toThrow(/No signing key material/);
    const base = { NODE_ENV: 'development', SUPABASE_JWT_SECRET: 'x'.repeat(40) };
    expect(envSchema.safeParse({ ...base, SIGNING_KEY: `${S2},${S1}` }).success).toBe(true);
    expect(envSchema.safeParse({ ...base, SIGNING_KEY: `${S2},short` }).success).toBe(false);
  });
});

describe('delivery codes survive key rotation', () => {
  it('a code issued before CREDENTIALS_KEYS rotation still verifies after it; a retired key no longer does', () => {
    const before = delivery(env({ CREDENTIALS_KEYS: K1 }));
    const stored = before.otpHash(JOB, '4821');
    const rotated = delivery(env({ CREDENTIALS_KEYS: `${K2},${K1}` }));
    expect(rotated.otpMatches(JOB, '4821', stored)).toBe(true);
    expect(rotated.otpMatches(JOB, '4822', stored)).toBe(false);
    expect(rotated.otpHash(JOB, '4821')).not.toBe(stored); // new codes use the new key
    expect(delivery(env({ CREDENTIALS_KEYS: K2 })).otpMatches(JOB, '4821', stored)).toBe(false);
  });

  it('introducing or rotating SIGNING_KEY keeps outstanding codes valid', () => {
    const stored = delivery(env({ CREDENTIALS_KEYS: K1 })).otpHash(JOB, '0007');
    expect(delivery(env({ SIGNING_KEY: S1, CREDENTIALS_KEYS: K1 })).otpMatches(JOB, '0007', stored)).toBe(true);
    const signed = delivery(env({ SIGNING_KEY: S1, CREDENTIALS_KEYS: K1 })).otpHash(JOB, '0008');
    expect(delivery(env({ SIGNING_KEY: `${S2},${S1}`, CREDENTIALS_KEYS: K1 })).otpMatches(JOB, '0008', signed)).toBe(true);
  });
});

describe('signed media URLs survive key rotation', () => {
  let dir: string;
  const objectPath = 'org-1/menu/item.png';
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'resuto-keys-'));
    await mkdir(path.join(dir, 'tenant-media', 'org-1', 'menu'), { recursive: true });
    await writeFile(path.join(dir, 'tenant-media', objectPath), 'png-bytes');
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  const storage = (keys: string) => new StorageService(env({ CREDENTIALS_KEYS: keys, STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: dir, API_ORIGIN: 'http://api.test' }));
  it('a URL signed before rotation still opens after it', async () => {
    const url = new URL(await storage(K1).signedUrl(objectPath, 600));
    const exp = Number(url.searchParams.get('exp'));
    const sig = url.searchParams.get('sig')!;
    expect(String(await storage(`${K2},${K1}`).readSigned(objectPath, exp, sig))).toBe('png-bytes');
    expect(await storage(K2).readSigned(objectPath, exp, sig)).toBeNull();
    expect(await storage(`${K2},${K1}`).readSigned(objectPath, exp, `${sig.slice(0, -2)}xx`)).toBeNull();
  });
});
