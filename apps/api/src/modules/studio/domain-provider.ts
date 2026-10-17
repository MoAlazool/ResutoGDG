import { resolveTxt } from 'node:dns/promises';
import type { DnsRecordInstruction } from '@resuto/contracts';

/** Injection token for the DNS TXT resolver (tests inject a stub; production uses node:dns). */
export const DNS_RESOLVER = Symbol('DNS_RESOLVER');
export type TxtResolver = (name: string) => Promise<string[][]>;
export const systemTxtResolver: TxtResolver = (name) => resolveTxt(name);

/** Injection token for the hosting provider that routes custom domains to the web app. */
export const DOMAIN_PROVIDER = Symbol('DOMAIN_PROVIDER');

export interface DomainAttachResult {
  /** Records the restaurant must create at its DNS host so traffic reaches Resuto. */
  routingRecords: DnsRecordInstruction[];
  instructions: string[];
  details: Record<string, unknown>;
}

export interface DomainStatusResult {
  /** True only when the hosting provider itself confirms the domain is configured and verified. */
  active: boolean;
  sslIssued: boolean;
  instructions: string[];
  details: Record<string, unknown>;
}

/**
 * Hosting-provider integration. Resuto verifies domain ownership itself (TXT
 * record); routing and TLS are the provider's job and a domain is only marked
 * "active" when the provider confirms it.
 */
export interface DomainProvider {
  readonly id: 'vercel' | 'manual';
  readonly readiness: 'implemented_unverified' | 'manual';
  attach(hostname: string): Promise<DomainAttachResult>;
  status(hostname: string): Promise<DomainStatusResult>;
  detach(hostname: string): Promise<void>;
}

const isApex = (hostname: string) => hostname.split('.').length === 2;

/**
 * Manual mode: no provider API is configured. Resuto shows the DNS records the
 * operator documented (DOMAIN_CNAME_TARGET / DOMAIN_A_RECORD) and never claims
 * the domain is active — a platform operator must attach it at the host.
 */
export class ManualDomainProvider implements DomainProvider {
  readonly id = 'manual' as const;
  readonly readiness = 'manual' as const;
  constructor(private readonly cnameTarget: string | undefined, private readonly aRecord: string | undefined) {}

  async attach(hostname: string): Promise<DomainAttachResult> {
    const routingRecords = this.records(hostname);
    return {
      routingRecords,
      instructions: [
        routingRecords.length
          ? 'Create the routing record below at your DNS provider.'
          : 'Resuto support will send you the routing record for your hosting setup.',
        'Hosting is configured manually for this Resuto installation: the domain stays "provisioning" until a Resuto operator attaches it to the web host and confirms HTTPS.',
      ],
      details: { mode: 'manual' },
    };
  }

  async status(hostname: string): Promise<DomainStatusResult> {
    return {
      active: false,
      sslIssued: false,
      instructions: [`Waiting for a Resuto operator to attach ${hostname} to the web host. No hosting-provider API is configured.`],
      details: { mode: 'manual' },
    };
  }

  async detach(): Promise<void> {}

  private records(hostname: string): DnsRecordInstruction[] {
    if (isApex(hostname)) return this.aRecord ? [{ type: 'A', name: hostname, value: this.aRecord, purpose: 'routing' }] : [];
    return this.cnameTarget ? [{ type: 'CNAME', name: hostname, value: this.cnameTarget, purpose: 'routing' }] : [];
  }
}

/**
 * Vercel project domains (https://vercel.com/docs/rest-api/reference/endpoints/projects).
 * Readiness: implemented_unverified — written against the public REST API docs,
 * not exercised with real credentials in this repository.
 *  - attach: POST /v10/projects/{project}/domains { name }
 *  - status: GET /v9/projects/{project}/domains/{domain} (verified) and
 *            GET /v6/domains/{domain}/config (misconfigured)
 *  - detach: DELETE /v9/projects/{project}/domains/{domain}
 * Vercel's documented records: apex → A 76.76.21.21, subdomain → CNAME cname.vercel-dns.com.
 */
export class VercelDomainProvider implements DomainProvider {
  readonly id = 'vercel' as const;
  readonly readiness = 'implemented_unverified' as const;
  private readonly base = 'https://api.vercel.com';

  constructor(private readonly token: string, private readonly projectId: string, private readonly teamId: string | undefined,
    private readonly http: typeof fetch = fetch) {}

  async attach(hostname: string): Promise<DomainAttachResult> {
    const res = await this.call('POST', `/v10/projects/${encodeURIComponent(this.projectId)}/domains`, { name: hostname });
    // 409 domain_already_in_use / already exists on this project is fine to treat as attached to this project only if verified later.
    if (!res.ok && res.status !== 409) throw new Error(`Vercel rejected the domain (${res.status}): ${res.error ?? 'unknown error'}`);
    const verification = Array.isArray(res.body?.verification) ? res.body.verification : [];
    const routingRecords: DnsRecordInstruction[] = isApex(hostname)
      ? [{ type: 'A', name: hostname, value: '76.76.21.21', purpose: 'routing' }]
      : [{ type: 'CNAME', name: hostname, value: 'cname.vercel-dns.com', purpose: 'routing' }];
    for (const v of verification) {
      if (v?.type && v?.domain && v?.value) routingRecords.push({ type: v.type, name: v.domain, value: v.value, purpose: 'ownership' });
    }
    return {
      routingRecords,
      instructions: [
        isApex(hostname)
          ? `Create an A record for ${hostname} pointing to 76.76.21.21 (Vercel).`
          : `Create a CNAME record for ${hostname} pointing to cname.vercel-dns.com (Vercel).`,
        'Vercel issues the HTTPS certificate automatically once DNS resolves; this can take a few minutes up to 48 hours.',
      ],
      details: { mode: 'vercel', verified: res.body?.verified ?? false, attachStatus: res.status },
    };
  }

  async status(hostname: string): Promise<DomainStatusResult> {
    const project = await this.call('GET', `/v9/projects/${encodeURIComponent(this.projectId)}/domains/${encodeURIComponent(hostname)}`);
    if (!project.ok) throw new Error(`Vercel domain lookup failed (${project.status}): ${project.error ?? 'unknown error'}`);
    const config = await this.call('GET', `/v6/domains/${encodeURIComponent(hostname)}/config`);
    if (!config.ok) throw new Error(`Vercel domain config lookup failed (${config.status}): ${config.error ?? 'unknown error'}`);
    const verified = project.body?.verified === true;
    const misconfigured = config.body?.misconfigured !== false;
    const active = verified && !misconfigured;
    return {
      active,
      sslIssued: active,
      instructions: active ? [] : [
        !verified ? 'Vercel has not verified the domain yet. Check the TXT record Vercel requested.' : '',
        misconfigured ? 'Vercel reports the DNS records are not pointing to Vercel yet.' : '',
      ].filter(Boolean),
      details: { mode: 'vercel', verified, misconfigured },
    };
  }

  async detach(hostname: string): Promise<void> {
    const res = await this.call('DELETE', `/v9/projects/${encodeURIComponent(this.projectId)}/domains/${encodeURIComponent(hostname)}`);
    if (!res.ok && res.status !== 404) throw new Error(`Vercel domain removal failed (${res.status})`);
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; body: any; error?: string }> {
    const url = new URL(this.base + path);
    if (this.teamId) url.searchParams.set('teamId', this.teamId);
    const res = await this.http(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { ok: res.ok, status: res.status, body: json, error: json?.error?.message ?? json?.error?.code };
  }
}

/** Chooses the provider from the environment (DOMAIN_PROVIDER=vercel needs VERCEL_TOKEN and VERCEL_PROJECT_ID). */
export function domainProviderFromEnv(env: NodeJS.ProcessEnv = process.env): DomainProvider {
  if (env.DOMAIN_PROVIDER === 'vercel') {
    if (!env.VERCEL_TOKEN || !env.VERCEL_PROJECT_ID) throw new Error('DOMAIN_PROVIDER=vercel requires VERCEL_TOKEN and VERCEL_PROJECT_ID');
    return new VercelDomainProvider(env.VERCEL_TOKEN, env.VERCEL_PROJECT_ID, env.VERCEL_TEAM_ID || undefined);
  }
  return new ManualDomainProvider(env.DOMAIN_CNAME_TARGET || undefined, env.DOMAIN_A_RECORD || undefined);
}
