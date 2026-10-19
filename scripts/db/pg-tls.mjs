// Verified TLS for Postgres connections made by scripts (migrations, demo loader). Mirrors
// apps/api/src/common/db/pg-tls.ts: with DATABASE_SSL_CA set (a PEM path or PEM text), the connection verifies
// the server certificate chain and host name, and any sslmode in the URL (e.g. no-verify) is ignored.
import { readFileSync } from 'node:fs';

export function pgClientConfig(url, ca = process.env.DATABASE_SSL_CA) {
  if (!ca) return { connectionString: url };
  const pem = ca.includes('-----BEGIN CERTIFICATE-----') ? ca : readFileSync(ca, 'utf8');
  const u = new URL(url);
  for (const k of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) u.searchParams.delete(k);
  return { connectionString: u.toString(), ssl: { ca: pem, rejectUnauthorized: true, servername: u.hostname } };
}
