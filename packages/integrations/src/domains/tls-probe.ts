// Reads the certificate a hostname actually serves (INT-27): "HTTPS works" is a fact about the edge, not something to
// infer from the hosting provider's "verified" flag. A TLS handshake with SNI = hostname on port 443; nothing is sent
// over the connection. The certificate counts as issued only when the chain validates against the system trust store,
// it covers the hostname (RFC 6125 via tls.checkServerIdentity) and it is inside its validity period.
// The hostname is tenant-supplied, so it is resolved first and refused when any address is not public (same policy as
// the outbound egress guard, ../net.ts).
import { checkServerIdentity, connect as tlsConnect, type ConnectionOptions, type PeerCertificate, type TLSSocket } from 'node:tls';
import { assertEgressAllowed, type HostResolver } from '../net';

export interface CertificateProbe {
  hostname: string;
  /** True only when the served certificate is trusted, covers the hostname and is currently valid. */
  issued: boolean;
  reason: 'ok' | 'untrusted_chain' | 'name_mismatch' | 'expired' | 'not_yet_valid' | 'no_certificate' | 'connect_failed' | 'blocked_address';
  issuer: string | null;
  validFrom: string | null;
  validTo: string | null;
  /** Days until expiry (negative when expired). */
  daysLeft: number | null;
  checkedAt: string;
}

export interface ProbeOptions {
  resolve?: HostResolver;
  /** Test hook: returns the peer certificate and whether the chain was authorised. */
  handshake?: (opts: ConnectionOptions) => Promise<{ cert: PeerCertificate | null; authorized: boolean; authorizationError: string | null }>;
  timeoutMs?: number;
  now?: () => Date;
}

const defaultHandshake = (opts: ConnectionOptions, timeoutMs: number) =>
  new Promise<{ cert: PeerCertificate | null; authorized: boolean; authorizationError: string | null }>((resolve, reject) => {
    const socket: TLSSocket = tlsConnect({ ...opts, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate();
      const out = { cert: cert && Object.keys(cert).length ? cert : null, authorized: socket.authorized, authorizationError: socket.authorizationError ? String(socket.authorizationError) : null };
      socket.end();
      resolve(out);
    });
    socket.setTimeout(timeoutMs, () => { socket.destroy(); reject(new Error('timeout')); });
    socket.once('error', reject);
  });

export async function probeCertificate(hostname: string, opts: ProbeOptions = {}): Promise<CertificateProbe> {
  const now = opts.now ?? (() => new Date());
  const base = { hostname, issuer: null, validFrom: null, validTo: null, daysLeft: null, checkedAt: now().toISOString() };
  let address = hostname;
  try {
    await assertEgressAllowed(`https://${hostname}/`, { provider: 'tls_probe', resolve: async (h) => {
      const list = await (opts.resolve ?? (async (name) => (await import('node:dns/promises')).lookup(name, { all: true, verbatim: true })))(h);
      address = list[0]!.address;
      return list;
    } });
  } catch {
    return { ...base, issued: false, reason: 'blocked_address' };
  }
  let hs: Awaited<ReturnType<NonNullable<ProbeOptions['handshake']>>>;
  try {
    const options: ConnectionOptions = { host: address, port: 443, servername: hostname };
    hs = await (opts.handshake ? opts.handshake(options) : defaultHandshake(options, opts.timeoutMs ?? 8_000));
  } catch {
    return { ...base, issued: false, reason: 'connect_failed' };
  }
  if (!hs.cert) return { ...base, issued: false, reason: 'no_certificate' };
  const c = hs.cert;
  const validFrom = new Date(c.valid_from);
  const validTo = new Date(c.valid_to);
  const info = {
    ...base,
    issuer: [c.issuer?.O, c.issuer?.CN].filter(Boolean).join(' / ') || null,
    validFrom: Number.isNaN(validFrom.getTime()) ? null : validFrom.toISOString(),
    validTo: Number.isNaN(validTo.getTime()) ? null : validTo.toISOString(),
    daysLeft: Number.isNaN(validTo.getTime()) ? null : Math.floor((validTo.getTime() - now().getTime()) / 86_400_000),
  };
  if (Number.isNaN(validTo.getTime()) || validTo.getTime() <= now().getTime()) return { ...info, issued: false, reason: 'expired' };
  if (!Number.isNaN(validFrom.getTime()) && validFrom.getTime() > now().getTime()) return { ...info, issued: false, reason: 'not_yet_valid' };
  if (checkServerIdentity(hostname, c)) return { ...info, issued: false, reason: 'name_mismatch' };
  if (!hs.authorized) return { ...info, issued: false, reason: 'untrusted_chain' };
  return { ...info, issued: true, reason: 'ok' };
}
