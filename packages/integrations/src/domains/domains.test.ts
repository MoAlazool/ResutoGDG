import type { PeerCertificate } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { runAcceptance } from '../acceptance/index';
import { ACCEPTANCE_CHECKS } from '../acceptance/registry';
import { domainParts, isApexDomain, normaliseHostname, probeCertificate, PSL_VERSION, VercelDomainsClient } from './index';

describe('Public Suffix List apex detection (INT-27)', () => {
  it('treats brand.com.eg and brand.com.sa as apex domains (the old label count did not)', () => {
    // Regression: hostname.split('.').length === 2 called these subdomains and handed out a CNAME at the zone apex.
    for (const apex of ['brand.com.eg', 'brand.com.sa', 'brand.eg', 'brand.sa', 'brand.com', 'brand.co.uk', 'brand.ae', 'brand.org.sa', 'brand.net.eg']) {
      expect(isApexDomain(apex), apex).toBe(true);
    }
    for (const sub of ['www.brand.com.eg', 'menu.brand.com.sa', 'www.brand.com', 'order.brand.co.uk', 'a.b.brand.eg']) {
      expect(isApexDomain(sub), sub).toBe(false);
    }
  });

  it('reports the public suffix, the registrable domain and the coverage of the bundled rules', () => {
    expect(domainParts('WWW.Brand.Com.EG.')).toMatchObject({ hostname: 'www.brand.com.eg', publicSuffix: 'com.eg', registrableDomain: 'brand.com.eg', isApex: false, pslCoverage: 'subset' });
    expect(domainParts('brand.com.sa')).toMatchObject({ publicSuffix: 'com.sa', registrableDomain: 'brand.com.sa', isApex: true });
    // A public suffix itself has no registrable domain and is never an apex a restaurant can own.
    expect(domainParts('com.eg')).toMatchObject({ publicSuffix: 'com.eg', registrableDomain: null, isApex: false });
    // Unknown TLD: the PSL default rule "*" applies and the result says so.
    expect(domainParts('brand.example')).toMatchObject({ publicSuffix: 'example', registrableDomain: 'brand.example', isApex: true, pslCoverage: 'subset' });
    expect(domainParts('brand.com').pslCoverage).toBe('subset');
    // jp has municipal rules that are not bundled: the answer is approximate and says so.
    expect(domainParts('brand.co.jp').pslCoverage).toBe('default_rule');
    expect(PSL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}/);
  });

  it('applies wildcard rules from the bundled list (*.sch.uk)', () => {
    expect(domainParts('school.kent.sch.uk')).toMatchObject({ publicSuffix: 'kent.sch.uk', registrableDomain: 'school.kent.sch.uk', isApex: true });
    expect(domainParts('www.school.kent.sch.uk').isApex).toBe(false);
  });

  it('rejects malformed hostnames', () => {
    for (const bad of ['', 'localhost', 'bad host.com', '-a.com', 'a..com', `${'a'.repeat(64)}.com`]) expect(() => normaliseHostname(bad), bad).toThrow();
  });
});

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('Vercel project domains client', () => {
  it('calls the documented endpoints with the team scope and fails closed on a missing misconfigured flag', async () => {
    const calls: string[] = [];
    let config: unknown = {};
    const http = (async (url: URL, init: RequestInit) => {
      calls.push(`${init.method} ${url.pathname}${url.search}`);
      if (init.method === 'POST') return json(200, { name: 'www.brand.com.eg', apexName: 'brand.com.eg', verified: true, verification: [] });
      if (init.method === 'DELETE') return json(200, {});
      if (url.pathname.startsWith('/v6/')) return json(200, config);
      return json(200, { name: 'www.brand.com.eg', apexName: 'brand.com.eg', verified: true });
    }) as unknown as typeof fetch;
    const c = new VercelDomainsClient({ token: 'tok', projectId: 'prj_1', teamId: 'team_2' }, http);
    expect((await c.add('www.brand.com.eg')).status).toBe(200);
    expect((await c.get('www.brand.com.eg'))?.apexName).toBe('brand.com.eg');
    expect((await c.config('www.brand.com.eg')).misconfigured).toBe(true);
    config = { misconfigured: false };
    expect((await c.config('www.brand.com.eg')).misconfigured).toBe(false);
    expect((await c.remove('www.brand.com.eg')).removed).toBe(true);
    expect(calls).toEqual([
      'POST /v10/projects/prj_1/domains?teamId=team_2',
      'GET /v9/projects/prj_1/domains/www.brand.com.eg?teamId=team_2',
      'GET /v6/domains/www.brand.com.eg/config?projectIdOrName=prj_1&teamId=team_2',
      'GET /v6/domains/www.brand.com.eg/config?projectIdOrName=prj_1&teamId=team_2',
      'DELETE /v9/projects/prj_1/domains/www.brand.com.eg?teamId=team_2',
    ]);
  });

  it('refuses to start without a token or project (fails closed)', () => {
    expect(() => new VercelDomainsClient({ token: '', projectId: 'p' })).toThrow(/required/);
  });
});

const cert = (over: Partial<PeerCertificate> = {}): PeerCertificate => ({
  subject: { CN: 'www.brand.com.eg' } as any, issuer: { O: "Let's Encrypt", CN: 'R11' } as any, subjectaltname: 'DNS:www.brand.com.eg',
  valid_from: 'Oct  1 00:00:00 2026 GMT', valid_to: 'Dec 30 00:00:00 2026 GMT', ...over,
} as PeerCertificate);
const publicResolver = async () => [{ address: '76.76.21.21', family: 4 }];
const now = () => new Date('2026-10-21T00:00:00Z');

describe('certificate probe (status read from the served certificate, not inferred)', () => {
  it('issued only for a trusted, current certificate that covers the hostname', async () => {
    const ok = await probeCertificate('www.brand.com.eg', { resolve: publicResolver, now, handshake: async (o) => {
      expect(o).toMatchObject({ host: '76.76.21.21', port: 443, servername: 'www.brand.com.eg' });
      return { cert: cert(), authorized: true, authorizationError: null };
    } });
    expect(ok).toMatchObject({ issued: true, reason: 'ok', issuer: "Let's Encrypt / R11", daysLeft: 70 });
    const hs = (c: PeerCertificate | null, authorized = true) => async () => ({ cert: c, authorized, authorizationError: authorized ? null : 'SELF_SIGNED' });
    expect((await probeCertificate('www.brand.com.eg', { resolve: publicResolver, now, handshake: hs(cert(), false) })).reason).toBe('untrusted_chain');
    expect((await probeCertificate('www.brand.com.eg', { resolve: publicResolver, now, handshake: hs(cert({ subjectaltname: 'DNS:*.vercel.app' })) })).reason).toBe('name_mismatch');
    expect((await probeCertificate('www.brand.com.eg', { resolve: publicResolver, now, handshake: hs(cert({ valid_to: 'Oct  1 00:00:00 2026 GMT' })) })).reason).toBe('expired');
    expect((await probeCertificate('www.brand.com.eg', { resolve: publicResolver, now, handshake: hs(null) })).reason).toBe('no_certificate');
    expect((await probeCertificate('www.brand.com.eg', { resolve: publicResolver, now, handshake: async () => { throw new Error('ECONNREFUSED'); } })).reason).toBe('connect_failed');
  });

  it('never connects to a hostname that resolves to a private address', async () => {
    let connected = false;
    const r = await probeCertificate('evil.brand.com.eg', { resolve: async () => [{ address: '169.254.169.254', family: 4 }],
      handshake: async () => { connected = true; return { cert: cert(), authorized: true, authorizationError: null }; } });
    expect(r).toMatchObject({ issued: false, reason: 'blocked_address' });
    expect(connected).toBe(false);
  });
});

describe('custom-domain acceptance check', () => {
  it('is listed, writes only in the official test mode and reports not_run without credentials', async () => {
    const check = ACCEPTANCE_CHECKS.find((c) => c.id === 'vercel.domain_attach_detach')!;
    expect(check).toMatchObject({ provider: 'vercel_domains', effect: 'write_test', modes: ['official_test'] });
    const fetch = (async () => { throw new Error('must not be called'); }) as any;
    const [r] = await runAcceptance([check], { mode: 'official_test', env: {}, fetch });
    expect(r).toMatchObject({ status: 'not_run', reason: 'not configured: VERCEL_TOKEN, VERCEL_PROJECT_ID, DOMAIN_ACCEPTANCE_ZONE' });
  });
});
