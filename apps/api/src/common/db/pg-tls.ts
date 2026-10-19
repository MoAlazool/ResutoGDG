import { readFileSync } from 'node:fs';
import type { ConnectionOptions } from 'node:tls';

/**
 * Postgres connection settings with verified TLS. With a CA (DATABASE_SSL_CA: a PEM path or PEM text) the server
 * certificate chain and host name are verified and any sslmode in the URL (e.g. no-verify) is ignored.
 * Same rules as scripts/db/pg-tls.mjs (used by migrations and the demo loader).
 */
export function pgClientConfig(url: string, ca: string | undefined): { connectionString: string; ssl?: ConnectionOptions } {
  if (!ca) return { connectionString: url };
  const pem = ca.includes('-----BEGIN CERTIFICATE-----') ? ca : readFileSync(ca, 'utf8');
  const u = new URL(url);
  for (const k of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) u.searchParams.delete(k);
  return { connectionString: u.toString(), ssl: { ca: pem, rejectUnauthorized: true, servername: u.hostname } };
}

const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/** Why a database URL would connect without a verified certificate, or null when TLS is verified or the host is local. */
export function unverifiedDatabaseTls(url: string, ca: string | undefined): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return 'DATABASE_URL is not a valid URL'; }
  if (LOCAL_HOSTS.includes(u.hostname) || ca) return null;
  const mode = u.searchParams.get('sslmode');
  if (mode === 'verify-full' && u.searchParams.get('sslrootcert')) return null;
  return `database TLS is not verified (sslmode=${mode ?? 'unset'}): set DATABASE_SSL_CA to the provider CA (scripts/db/certs/) or use sslmode=verify-full with sslrootcert`;
}
