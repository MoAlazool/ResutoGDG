// Vercel project domains client (INT-27), used by the API's DomainProvider and by the acceptance check.
// Docs (checked 2026-10-21 through Vercel's documentation search):
//   Add a domain to a project      POST   /v10/projects/{idOrName}/domains   { name }
//     https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project
//   Get a project domain           GET    /v9/projects/{idOrName}/domains/{domain}   → { name, apexName, verified, verification[] }
//     https://vercel.com/docs/rest-api/projects/get-a-project-domain
//   Verify a project domain        POST   /v9/projects/{idOrName}/domains/{domain}/verify
//   Get a domain's configuration   GET    /v6/domains/{domain}/config   → { misconfigured, … }
//     https://vercel.com/docs/rest-api/domains/get-a-domain-s-configuration
//   Remove a domain from a project DELETE /v9/projects/{idOrName}/domains/{domain}
//   Team scope: ?teamId=… on every call.
// Certificates: the REST API documents GET /v8/certs/{id} (by certificate id only) and no lookup by domain, so the
// certificate status is read from the certificate the edge actually serves for the hostname (./tls-probe.ts), not
// inferred from "verified".
// Records Vercel documents for external DNS: apex → A 76.76.21.21, subdomain → CNAME cname.vercel-dns.com
//   https://vercel.com/docs/domains/working-with-domains/add-a-domain
import { ProviderError } from '../core';

export const VERCEL_API = 'https://api.vercel.com';
export const VERCEL_APEX_A = '76.76.21.21';
export const VERCEL_CNAME = 'cname.vercel-dns.com';

export interface VercelDomainConfig { token: string; projectId: string; teamId?: string | null }
export interface VercelVerification { type: string; domain: string; value: string; reason?: string }
export interface VercelProjectDomain { name: string; apexName: string | null; verified: boolean; verification: VercelVerification[] }

export class VercelDomainsClient {
  constructor(private readonly cfg: VercelDomainConfig, private readonly http: typeof fetch = fetch) {
    if (!cfg.token || !cfg.projectId) throw new ProviderError('vercel', 'VERCEL_TOKEN and VERCEL_PROJECT_ID are required', false);
  }

  /** Adds the hostname to the project. 409 (already on this project) is returned as such, never as success. */
  async add(hostname: string): Promise<{ status: number; domain: VercelProjectDomain | null; error: string | null }> {
    const r = await this.call('POST', `/v10/projects/${encodeURIComponent(this.cfg.projectId)}/domains`, { name: hostname });
    if (!r.ok && r.status !== 409) throw new ProviderError('vercel', `adding the domain failed (HTTP ${r.status}${r.error ? `: ${r.error}` : ''})`, r.status >= 500 || r.status === 429, r.status);
    return { status: r.status, domain: r.ok ? toDomain(r.body) : null, error: r.ok ? null : r.error };
  }

  async get(hostname: string): Promise<VercelProjectDomain | null> {
    const r = await this.call('GET', `/v9/projects/${encodeURIComponent(this.cfg.projectId)}/domains/${encodeURIComponent(hostname)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new ProviderError('vercel', `domain lookup failed (HTTP ${r.status}${r.error ? `: ${r.error}` : ''})`, r.status >= 500 || r.status === 429, r.status);
    return toDomain(r.body);
  }

  async config(hostname: string): Promise<{ misconfigured: boolean }> {
    const r = await this.call('GET', `/v6/domains/${encodeURIComponent(hostname)}/config`, undefined, { projectIdOrName: this.cfg.projectId });
    if (!r.ok) throw new ProviderError('vercel', `domain configuration lookup failed (HTTP ${r.status}${r.error ? `: ${r.error}` : ''})`, r.status >= 500 || r.status === 429, r.status);
    // Anything but an explicit false is treated as misconfigured (fail closed).
    return { misconfigured: r.body?.misconfigured !== false };
  }

  async remove(hostname: string): Promise<{ removed: boolean }> {
    const r = await this.call('DELETE', `/v9/projects/${encodeURIComponent(this.cfg.projectId)}/domains/${encodeURIComponent(hostname)}`);
    if (r.status === 404) return { removed: false };
    if (!r.ok) throw new ProviderError('vercel', `removing the domain failed (HTTP ${r.status})`, r.status >= 500 || r.status === 429, r.status);
    return { removed: true };
  }

  private async call(method: string, path: string, body?: unknown, query: Record<string, string> = {}) {
    const url = new URL(VERCEL_API + path);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    if (this.cfg.teamId) url.searchParams.set('teamId', this.cfg.teamId);
    let res: Response;
    try {
      res = await this.http(url, {
        method, headers: { Authorization: `Bearer ${this.cfg.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new ProviderError('vercel', `network error: ${(e as Error).message}`, true);
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    const err = json?.error?.code ?? json?.error?.message;
    return { ok: res.ok, status: res.status, body: json, error: typeof err === 'string' ? err.slice(0, 120) : null };
  }
}

function toDomain(b: any): VercelProjectDomain {
  return {
    name: String(b?.name ?? ''), apexName: typeof b?.apexName === 'string' ? b.apexName : null, verified: b?.verified === true,
    verification: (Array.isArray(b?.verification) ? b.verification : []).filter((v: any) => v?.type && v?.domain && v?.value)
      .map((v: any) => ({ type: String(v.type), domain: String(v.domain), value: String(v.value), reason: v.reason ? String(v.reason) : undefined })),
  };
}
