import { resolveTxt } from 'node:dns/promises';
import type { DnsRecordInstruction } from '@resuto/contracts';
import { domainParts, probeCertificate, VERCEL_APEX_A, VERCEL_CNAME, VercelDomainsClient, type CertificateProbe } from '@resuto/integrations';

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
  /** True only when the hosting provider itself confirms the domain is configured and verified, and HTTPS works. */
  active: boolean;
  /** True only when the certificate served for the hostname was read and is valid for it (never inferred). */
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

/**
 * INT-27: apex detection with the Public Suffix List. "brand.com.eg" is an apex (com.eg is a public suffix) and must get
 * an A record: a CNAME at a zone apex is forbidden by DNS. The old label count treated it as a subdomain.
 */
const isApex = (hostname: string) => domainParts(hostname).isApex;
const pslDetails = (hostname: string) => {
  const p = domainParts(hostname);
  return { apex: p.isApex, registrableDomain: p.registrableDomain, publicSuffix: p.publicSuffix, pslCoverage: p.pslCoverage, pslVersion: p.pslVersion };
};

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
      details: { mode: 'manual', ...pslDetails(hostname) },
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
 * Vercel project domains through the shared client (packages/integrations/src/domains/vercel.ts, endpoints and doc links
 * there). Readiness: implemented_unverified — exercised only with scripted transports; the acceptance check
 * vercel.domain_attach_detach (scripts/providers/acceptance.mjs) attaches and detaches a throwaway subdomain once the
 * owner provides a staging token.
 * - active: Vercel reports the domain verified AND not misconfigured AND the edge serves a trusted certificate for it;
 * - sslIssued: read from the certificate actually served for the hostname (TLS probe), never inferred from "verified"
 *   (Vercel's REST API has no certificate lookup by domain, only GET /v8/certs/{id}).
 */
export class VercelDomainProvider implements DomainProvider {
  readonly id = 'vercel' as const;
  readonly readiness = 'implemented_unverified' as const;
  private readonly client: VercelDomainsClient;

  constructor(token: string, projectId: string, teamId: string | undefined, http: typeof fetch = fetch,
    private readonly probe: (hostname: string) => Promise<CertificateProbe> = (h) => probeCertificate(h)) {
    this.client = new VercelDomainsClient({ token, projectId, teamId: teamId ?? null }, http);
  }

  async attach(hostname: string): Promise<DomainAttachResult> {
    const res = await this.client.add(hostname);
    // 409: the domain is already on a project. It is not treated as success; status() decides from Vercel's answer.
    const apex = isApex(hostname);
    const routingRecords: DnsRecordInstruction[] = apex
      ? [{ type: 'A', name: hostname, value: VERCEL_APEX_A, purpose: 'routing' }]
      : [{ type: 'CNAME', name: hostname, value: VERCEL_CNAME, purpose: 'routing' }];
    for (const v of res.domain?.verification ?? []) routingRecords.push({ type: v.type as DnsRecordInstruction['type'], name: v.domain, value: v.value, purpose: 'ownership' });
    return {
      routingRecords,
      instructions: [
        apex
          ? `Create an A record for ${hostname} pointing to ${VERCEL_APEX_A} (Vercel). ${hostname} is the root of its domain, so a CNAME is not allowed there.`
          : `Create a CNAME record for ${hostname} pointing to ${VERCEL_CNAME} (Vercel).`,
        'Vercel issues the HTTPS certificate automatically once DNS resolves; this can take a few minutes up to 48 hours.',
      ],
      details: { mode: 'vercel', verified: res.domain?.verified ?? false, attachStatus: res.status, attachError: res.error, ...pslDetails(hostname) },
    };
  }

  async status(hostname: string): Promise<DomainStatusResult> {
    const domain = await this.client.get(hostname);
    if (!domain) throw new Error('Vercel does not list this domain on the project. Remove it and add it again.');
    const { misconfigured } = await this.client.config(hostname);
    const verified = domain.verified;
    // The certificate is only looked for once Vercel routes the domain; before that no certificate can exist.
    const cert = verified && !misconfigured ? await this.probe(hostname) : null;
    const sslIssued = cert?.issued === true;
    const active = verified && !misconfigured && sslIssued;
    return {
      active,
      sslIssued,
      instructions: active ? [] : [
        !verified ? 'Vercel has not verified the domain yet. Check the TXT record Vercel requested.' : '',
        misconfigured ? 'Vercel reports the DNS records are not pointing to Vercel yet.' : '',
        cert && !cert.issued ? `HTTPS is not ready yet (${cert.reason.replace(/_/g, ' ')}). Vercel issues the certificate once DNS resolves; check again later.` : '',
      ].filter(Boolean),
      details: {
        mode: 'vercel', verified, misconfigured, apexName: domain.apexName,
        certificate: cert ? { issued: cert.issued, reason: cert.reason, issuer: cert.issuer, validTo: cert.validTo, daysLeft: cert.daysLeft, checkedAt: cert.checkedAt } : null,
      },
    };
  }

  async detach(hostname: string): Promise<void> {
    await this.client.remove(hostname);
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
