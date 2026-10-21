// Custom-domain acceptance check (INT-27): attaches a throwaway subdomain to the Vercel project, reads it back, reads
// its DNS configuration and the certificate the edge serves, then detaches it. Vercel has no separate test API: run it
// against a staging project (VERCEL_PROJECT_ID of the staging web app) with a subdomain of a zone the owner controls.
// It creates and removes one project domain and never touches DNS.
import { domainParts, probeCertificate, VercelDomainsClient } from '../domains';
import { expectThat, registerChecks, type AcceptanceCheck } from './index';
import { runKey } from './payments-common';

export const domainChecks: AcceptanceCheck[] = [
  {
    id: 'vercel.domain_attach_detach', provider: 'vercel_domains', capability: 'attach_status_detach', modes: ['official_test'],
    requires: ['VERCEL_TOKEN', 'VERCEL_PROJECT_ID', 'DOMAIN_ACCEPTANCE_ZONE'], effect: 'write_test',
    prerequisites: [
      'Use the STAGING web project id. DOMAIN_ACCEPTANCE_ZONE is a domain you own (e.g. resuto-staging.example); a random "acc-…" subdomain of it is attached and removed.',
      'Optional: VERCEL_TEAM_ID when the project belongs to a team.',
    ],
    docsUrl: 'https://vercel.com/docs/rest-api/projects/add-a-domain-to-a-project',
    async run(ctx) {
      const zone = domainParts(ctx.env.DOMAIN_ACCEPTANCE_ZONE!);
      expectThat(zone.isApex, 'DOMAIN_ACCEPTANCE_ZONE must be a registrable domain (apex), e.g. example.com.eg');
      const host = `acc-${runKey('dom').replace(/[^a-z0-9]/g, '').slice(-10)}.${zone.hostname}`;
      const client = new VercelDomainsClient({ token: ctx.env.VERCEL_TOKEN!, projectId: ctx.env.VERCEL_PROJECT_ID!, teamId: process.env.VERCEL_TEAM_ID || null },
        ctx.adapter.fetch);
      const added = await client.add(host);
      ctx.evidence('attached', { status: added.status, verified: added.domain?.verified ?? null, verificationRecords: added.domain?.verification.length ?? null });
      try {
        expectThat(added.status === 200, `adding a fresh subdomain must return 200 (got ${added.status})`);
        const read = await client.get(host);
        expectThat(read?.name === host, 'the project does not list the attached subdomain');
        ctx.evidence('read back', { apexName: read?.apexName ?? null, verified: read?.verified ?? null, apexMatchesPsl: read?.apexName === zone.hostname });
        const cfg = await client.config(host);
        ctx.evidence('dns configuration', { misconfigured: cfg.misconfigured });
        const cert = await probeCertificate(host);
        ctx.evidence('certificate probe (no DNS record exists, so not issued is expected)', { issued: cert.issued, reason: cert.reason });
        expectThat(!cert.issued || !cfg.misconfigured, 'a certificate was served for a misconfigured domain');
      } finally {
        const removed = await client.remove(host);
        ctx.evidence('detached', { removed: removed.removed });
      }
      expectThat((await client.get(host)) === null, 'the subdomain is still attached after removal');
    },
  },
];

registerChecks(...domainChecks);
