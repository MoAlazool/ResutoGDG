// Outbound network guard for provider URLs that tenants type in (audit INT-02).
//
// Most adapters call fixed provider hosts (api.stripe.com, api.wafeq.com …). A few take the base URL from the
// connection settings (Odoo POS, Odoo Accounting): without a guard a tenant can point Resuto at
// http://169.254.169.254/, localhost or a private network and read the answer back through the connection's error.
// egressFetch() wraps any fetch implementation and, for every hop (the first request and each redirect):
//   * requires https: on port 443, no credentials in the URL;
//   * refuses local names (localhost, *.local, *.internal, metadata hosts) and IP literals in private, loopback,
//     link-local, CGNAT, multicast, documentation, benchmarking and reserved ranges (IPv4, IPv6, mapped/NAT64/6to4);
//   * resolves the host name and refuses it when ANY address is non-public;
//   * follows at most a few redirects manually (redirect: 'manual'), re-checking each target;
//   * caps the response body size.
// Residual risk: the HTTP client resolves the name again after our check (DNS rebinding). Requiring HTTPS on 443 with
// certificate validation means a rebound name must still present a valid certificate for the attacker's own host
// name, which internal plain-HTTP services (cloud metadata, admin ports) cannot do.
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ProviderError } from './core';

export interface ResolvedAddress { address: string; family: number }
export type HostResolver = (hostname: string) => Promise<ResolvedAddress[]>;

export interface EgressOptions {
  /** Provider id used in error messages. */
  provider: string;
  /** Allowed ports (default 443 only). */
  ports?: number[];
  /** Maximum redirects followed (default 3). */
  maxRedirects?: number;
  /** Maximum response body in bytes (default 5 MB). */
  maxResponseBytes?: number;
  /** DNS resolver (default: the system resolver, all addresses). */
  resolve?: HostResolver;
}

/** The URL was refused before any connection was made (never retryable, safe to show to the tenant). */
export class EgressBlockedError extends ProviderError {
  constructor(provider: string, readonly reason: string) {
    super(provider, `the address is not allowed (${reason}); use the public HTTPS address of your server`, false);
  }
}

/**
 * Test hook: a fetch implementation may carry its own resolver (tests run without DNS). Production fetches never
 * have this property; tenant-supplied settings are plain data and cannot set it.
 */
export const EGRESS_RESOLVER = Symbol.for('resuto.egress.resolver');
export function withEgressResolver<F extends typeof fetch>(fetchImpl: F, resolve: HostResolver): F {
  return Object.assign(fetchImpl, { [EGRESS_RESOLVER]: resolve });
}

const systemResolver: HostResolver = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));

const BLOCKED_NAMES = new Set(['localhost', 'metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.home.arpa', '.lan', '.intranet', '.corp'];

function ipv4ToInt(ip: string): number {
  const p = ip.split('.').map(Number);
  return ((p[0]! << 24) >>> 0) + (p[1]! << 16) + (p[2]! << 8) + p[3]!;
}
const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V4_RANGES = V4_BLOCKED.map(([base, bits]) => ({ base: ipv4ToInt(base), mask: bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0 }));

function publicIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return !V4_RANGES.some((r) => ((n & r.mask) >>> 0) === r.base);
}

/** Expands an IPv6 address (with optional embedded IPv4 tail) to 8 16-bit groups. */
function ipv6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    if (isIP(v4[1]!) !== 4) return null;
    const n = ipv4ToInt(v4[1]!);
    tail = [n >>> 16, n & 0xffff];
    s = s.slice(0, -v4[1]!.length) + (s.endsWith(':' + v4[1]) ? '0' : '');
    s = s.replace(/:0$/, ':');
    if (s.endsWith(':') && !s.endsWith('::')) s = s.slice(0, -1);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const head = parse(halves[0]!);
  const rest = halves.length === 2 ? parse(halves[1]!) : [];
  const fill = 8 - tail.length - head.length - rest.length;
  if (halves.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  const groups = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...rest, ...tail];
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

const v4FromGroups = (hi: number, lo: number) => `${hi >>> 8}.${hi & 0xff}.${lo >>> 8}.${lo & 0xff}`;

function publicIpv6(ip: string): boolean {
  const g = ipv6Groups(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return false; // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false; // ::1
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return publicIpv4(v4FromGroups(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return false; // deprecated IPv4-compatible ::a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return publicIpv4(v4FromGroups(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1) return false; // local-use NAT64 64:ff9b:1::/48
  if (g[0] === 0x2002) return publicIpv4(v4FromGroups(g[1]!, g[2]!)); // 6to4 embeds an IPv4 address
  if (g[0] === 0x100 && g.slice(1, 4).every((x) => x === 0)) return false; // discard-only 100::/64
  if (g[0] === 0x2001 && g[1]! < 0x200) return false; // 2001::/23 IETF special purpose (Teredo, benchmarking, ORCHID …)
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false; // documentation 3fff::/20
  if ((g[0]! & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return false; // site-local fec0::/10 (deprecated)
  if ((g[0]! & 0xff00) === 0xff00) return false; // multicast
  return true;
}

/** True when the address is a routable public unicast address (not private, loopback, link-local, metadata …). */
export function isPublicAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return publicIpv4(ip);
  if (v === 6) return publicIpv6(ip);
  return false;
}

/** Checks one URL against the egress policy (syntax, port, name, every resolved address). */
export async function assertEgressAllowed(input: string | URL, options: EgressOptions): Promise<URL> {
  const { provider } = options;
  let url: URL;
  try { url = new URL(String(input)); } catch { throw new EgressBlockedError(provider, 'invalid URL'); }
  if (url.protocol !== 'https:') throw new EgressBlockedError(provider, 'HTTPS only');
  if (url.username || url.password) throw new EgressBlockedError(provider, 'credentials in the URL');
  const port = url.port ? Number(url.port) : 443;
  if (!(options.ports ?? [443]).includes(port)) throw new EgressBlockedError(provider, `port ${port}`);
  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (!host) throw new EgressBlockedError(provider, 'missing host');
  if (isIP(host)) {
    if (!isPublicAddress(host)) throw new EgressBlockedError(provider, 'private or reserved address');
    return url;
  }
  if (!host.includes('.') || BLOCKED_NAMES.has(host) || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new EgressBlockedError(provider, 'local host name');
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await (options.resolve ?? systemResolver)(host);
  } catch {
    throw new ProviderError(provider, `could not resolve ${host}`, true);
  }
  if (!addresses.length) throw new ProviderError(provider, `could not resolve ${host}`, true);
  if (addresses.some((a) => !isPublicAddress(a.address))) throw new EgressBlockedError(provider, 'resolves to a private or reserved address');
  return url;
}

async function readCapped(res: Response, max: number, provider: string): Promise<ArrayBuffer> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new ProviderError(provider, 'response too large', false, res.status);
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      throw new ProviderError(provider, 'response too large', false, res.status);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out.buffer;
}

/**
 * Wraps a fetch implementation with the egress policy. The returned function has the fetch signature, so it can be
 * handed to providerRequest() via the adapter context.
 */
export function egressFetch(base: typeof fetch, options: EgressOptions): typeof fetch {
  const maxRedirects = options.maxRedirects ?? 3;
  const maxBytes = options.maxResponseBytes ?? 5 * 1024 * 1024;
  const resolve = options.resolve ?? (base as unknown as Record<symbol, HostResolver | undefined>)[EGRESS_RESOLVER];
  const policy = { ...options, resolve };
  return (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    let target = input instanceof Request ? input.url : String(input);
    let method = (init.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    let body = init.body;
    for (let hop = 0; ; hop++) {
      const url = await assertEgressAllowed(target, policy);
      const res = await base(url.toString(), { ...init, method, body, redirect: 'manual' });
      const location = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && location) {
        await res.body?.cancel().catch(() => undefined);
        if (hop >= maxRedirects) throw new ProviderError(options.provider, 'too many redirects', false, res.status);
        target = new URL(location, url).toString();
        // Per the fetch spec: 303 (and 301/302 after POST) continue as GET without a body.
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) { method = 'GET'; body = undefined; }
        continue;
      }
      const buf = await readCapped(res, maxBytes, options.provider);
      return new Response(res.status === 204 || res.status === 304 ? null : buf, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
  }) as typeof fetch;
}

/**
 * Runs one provider call against a tenant-supplied URL: the URL is checked before anything is sent (a refusal is
 * immediate and not retryable), every hop goes through egressFetch(), and any failure comes back as our own text
 * (redactProviderError), never the server's body. `call` receives the guarded fetch to hand to providerRequest().
 */
export async function guardedProviderCall<T>(provider: string, base: typeof fetch, url: string, call: (guardedFetch: typeof globalThis.fetch) => Promise<T>,
  options: Omit<EgressOptions, 'provider'> = {}): Promise<T> {
  const policy: EgressOptions = { ...options, provider, resolve: options.resolve ?? (base as unknown as Record<symbol, HostResolver | undefined>)[EGRESS_RESOLVER] };
  await assertEgressAllowed(url, policy);
  const guarded = egressFetch(base, policy);
  let blocked: EgressBlockedError | undefined;
  const tracked = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    try { return await guarded(input, init); } catch (error) {
      if (error instanceof EgressBlockedError) blocked = error; // e.g. a redirect into a private network
      throw error;
    }
  }) as typeof fetch;
  try {
    return await call(tracked);
  } catch (error) {
    throw blocked ?? redactProviderError(provider, error);
  }
}

/**
 * Error text that is safe to store for the tenant: our own message, never the provider's response body. Used by the
 * adapters whose base URL the tenant chooses (the body could come from any server).
 */
export function redactProviderError(provider: string, error: unknown): Error {
  if (error instanceof EgressBlockedError) return error;
  if (error instanceof ProviderError) {
    const status = error.status;
    const msg = status ? `HTTP ${status}` : error.message.replace(/^[^:]+:\s*/, '').replace(/network error: .*/, 'network error').slice(0, 120);
    return new ProviderError(provider, msg, error.retryable, status, error.retryAfterMs);
  }
  return error instanceof Error ? error : new Error(String(error));
}
