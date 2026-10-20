// Verified database TLS: deployed environments refuse unverified TLS, and the pg settings really verify the
// server certificate (checked against a local endpoint that speaks the Postgres SSLRequest handshake).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TLSSocket } from 'node:tls';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pgClientConfig, unverifiedDatabaseTls } from '../src/common/db/pg-tls';
import { envSchema } from '../src/config/env';

const base = {
  NODE_ENV: 'staging', SUPABASE_URL: 'https://example-ref.supabase.co', CREDENTIALS_KEYS: 'k1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  AUTH_DEV_MODE: 'false', STORAGE_DRIVER: 'local', PAYMENT_MODE: 'sandbox',
};
const REMOTE = 'postgres://u:p@aws-0-eu-central-1.pooler.supabase.com:5432/postgres';
const SUPABASE_CA = join(__dirname, '../../../scripts/db/certs/supabase-prod-ca-2021.crt');
const issues = (env: Record<string, string>) => {
  const r = envSchema.safeParse(env);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('deployed environments require verified database TLS', () => {
  it('refuses sslmode=no-verify, require or no sslmode for a remote database without a CA', () => {
    for (const q of ['?sslmode=no-verify', '?sslmode=require', '']) {
      expect(issues({ ...base, DATABASE_URL: `${REMOTE}${q}` }).join()).toMatch(/DATABASE_URL: staging: database TLS is not verified/);
    }
  });

  it('accepts a remote database with DATABASE_SSL_CA, or verify-full with sslrootcert, and local databases as they are', () => {
    expect(issues({ ...base, DATABASE_URL: `${REMOTE}?sslmode=no-verify`, DATABASE_SSL_CA: SUPABASE_CA })).toEqual([]);
    expect(issues({ ...base, DATABASE_URL: `${REMOTE}?sslmode=verify-full&sslrootcert=/ca.pem` })).toEqual([]);
    expect(issues({ ...base, DATABASE_URL: 'postgres://postgres@127.0.0.1:54329/resuto' })).toEqual([]);
    expect(unverifiedDatabaseTls(`${REMOTE}?sslmode=no-verify`, undefined)).not.toBeNull();
    expect(issues({ ...base, NODE_ENV: 'development', DATABASE_URL: `${REMOTE}?sslmode=no-verify` })).toEqual([]);
  });

  it('ships the Supabase root CA and strips sslmode overrides when a CA is configured', () => {
    expect(readFileSync(SUPABASE_CA, 'utf8')).toContain('-----BEGIN CERTIFICATE-----');
    const cfg = pgClientConfig(`${REMOTE}?sslmode=no-verify`, SUPABASE_CA);
    expect(cfg.connectionString).not.toContain('sslmode');
    expect(cfg.ssl).toMatchObject({ rejectUnauthorized: true, servername: 'aws-0-eu-central-1.pooler.supabase.com' });
    expect(String(cfg.ssl?.ca)).toContain('BEGIN CERTIFICATE');
    expect(pgClientConfig(REMOTE, undefined)).toEqual({ connectionString: REMOTE });
  });
});

describe('certificate verification against a TLS endpoint', () => {
  let dir = '';
  let port = 0;
  const server = createServer((raw: Socket) => {
    // Postgres SSLRequest: 8 bytes (length 8, code 80877103) answered with 'S', then TLS.
    raw.once('data', () => {
      raw.write('S');
      const tls = new TLSSocket(raw, { isServer: true, key: readFileSync(join(dir, 'server.key')), cert: readFileSync(join(dir, 'server.crt')) });
      tls.on('error', () => raw.destroy());
      tls.once('data', () => tls.destroy()); // reached only after a successful handshake
    });
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'resuto-tls-'));
    const sh = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
    sh(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=Test CA', '-keyout', 'ca.key', '-out', 'ca.crt']);
    sh(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost', '-keyout', 'server.key', '-out', 'server.csr']);
    execFileSync('sh', ['-c', 'printf "subjectAltName=DNS:localhost" > ext.cnf'], { cwd: dir });
    sh(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '1', '-extfile', 'ext.cnf', '-out', 'server.crt']);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  const attempt = async (host: string, ca: string) => {
    const client = new pg.Client({ ...pgClientConfig(`postgres://u:p@${host}:${port}/db?sslmode=no-verify`, ca), connectionTimeoutMillis: 3000 });
    try { await client.connect(); return 'connected'; } catch (e) { return (e as Error).message; } finally { await client.end().catch(() => undefined); }
  };

  it('rejects a server certificate that does not chain to the configured CA, even with sslmode=no-verify in the URL', async () => {
    expect(await attempt('localhost', SUPABASE_CA)).toMatch(/self[- ]signed|unable to (get|verify)|certificate/i);
  });

  it('rejects a trusted certificate issued for a different host name', async () => {
    expect(await attempt('127.0.0.1', join(dir, 'ca.crt'))).toMatch(/altnames|Hostname|IP: 127\.0\.0\.1/i);
  });

  it('completes the TLS handshake when chain and host name verify', async () => {
    // The fake server closes after the handshake, so the client fails later — but not on the certificate.
    expect(await attempt('localhost', join(dir, 'ca.crt'))).not.toMatch(/certificate|altnames|self[- ]signed/i);
  });
});
