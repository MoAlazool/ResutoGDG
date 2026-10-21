'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { assignableRoles, MCP_ACTING_ROLES, type Role } from '@resuto/contracts';
import { Badge, Card, KeyValueList, Notice, PageHeader, useAction } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { endOfDayIso, LoadState, ScopeForm, type CatalogTool, type ScopeValue } from '../_components/shared';

interface OAuthRequest {
  id: string; status: 'pending' | 'approved' | 'denied' | 'expired'; clientName: string; clientId: string; clientKind: 'dynamic' | 'metadata_document';
  clientUri: string | null; redirectHost: string; redirectUri: string; loopbackRedirect: boolean; scopes: string[]; tools: string[];
  resource: string; expiresAt: string;
}

/**
 * OAuth consent for an MCP client (FT-17): the admin sees who asks, where the browser goes back to (the redirect host,
 * as the MCP spec requires), what is asked, and chooses the role, branches and tools, exactly like a connection key.
 */
function Consent() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const session = useSession();
  const request = useSearchParams().get('request') ?? '';
  const req = useApi<OAuthRequest>(/^[0-9a-f-]{36}$/i.test(request) ? `/mcp/oauth/requests/${request}` : null, { staleMs: 0 });
  const catalog = useApi<{ items: CatalogTool[] }>(`/o/${org.id}/mcp/catalog`);
  const [leaving, setLeaving] = useState<string | null>(null);
  const roles = assignableRoles(org.role).filter((r) => (MCP_ACTING_ROLES as readonly string[]).includes(r));
  const defaultRole: Role = roles.includes('manager') ? 'manager' : roles[0] ?? 'manager';

  const approve = useAction(async (v: ScopeValue) => {
    const r = await session.call<{ redirectTo: string }>(`/o/${org.id}/mcp/oauth/requests/${request}/approve`, {
      body: { name: v.name, actingRole: v.actingRole, branchIds: v.branchIds, allowedTools: v.allowedTools, rateLimitPerMin: v.rateLimitPerMin,
        expiresAt: endOfDayIso(v.expiresOn) },
    });
    setLeaving(req.data?.redirectHost ?? '');
    window.location.assign(r.redirectTo);
  });
  const deny = useAction(async () => {
    const r = await session.call<{ redirectTo: string }>(`/mcp/oauth/requests/${request}/deny`, { body: {} });
    setLeaving(req.data?.redirectHost ?? '');
    window.location.assign(r.redirectTo);
  });

  const d = req.data;
  const permitted = (catalog.data?.items ?? []).filter((x) => d?.tools.includes(x.name));
  return (
    <ModuleGate module="mcp" permission="mcp:manage">
      <div style={{ containerType: 'inline-size' }}>
        <PageHeader overline="ResutoMCP" title={t('mcp.oauth.title')} subtitle={t('mcp.oauth.subtitle')} />
        <LoadState loading={(req.loading && !d) || (catalog.loading && !catalog.data)} error={req.error ?? catalog.error} retry={req.reload}>
          {d && d.status !== 'pending' ? <Notice tone="warn">{t(`mcp.oauth.closed.${d.status}`)}</Notice> : d && (
            <div className="stack" style={{ gap: 16 }}>
              <Card warm>
                <div className="stack" style={{ gap: 12 }}>
                  <p style={{ margin: 0, fontSize: 17 }}>{t('mcp.oauth.asks', { client: d.clientName, org: org.name })}</p>
                  <KeyValueList items={[
                    { key: 'return', label: t('mcp.oauth.returnTo'), value: <strong><bdi dir="ltr">{d.redirectHost}</bdi></strong> },
                    { key: 'kind', label: t('mcp.oauth.clientKind'), value: d.clientKind === 'metadata_document'
                      ? <span>{t('mcp.oauth.kind.metadata')} <bdi dir="ltr" className="fine">{d.clientId}</bdi></span> : t('mcp.oauth.kind.dynamic') },
                    { key: 'scopes', label: t('mcp.oauth.scopes'), value: <span className="row" style={{ gap: 6 }}>{d.scopes.map((s) => <Badge key={s} tone={s === 'mcp:act' ? 'warn' : 'ok'}>{t(`mcp.oauth.scope.${s}`)}</Badge>)}</span> },
                    { key: 'expires', label: t('mcp.oauth.expires'), value: dateTime(d.expiresAt, locale, org.timezone) },
                  ]} />
                  {d.loopbackRedirect && <Notice tone="warn">{t('mcp.oauth.loopback')}</Notice>}
                  <p className="fine" style={{ margin: 0 }}>{t('mcp.oauth.howItWorks')}</p>
                </div>
              </Card>
              {leaving !== null ? <Notice tone="info">{t('mcp.oauth.leaving', { host: leaving })}</Notice> : (
                <>
                  <ScopeForm
                    catalog={permitted}
                    initial={{ name: d.clientName.slice(0, 80), actingRole: defaultRole, branchIds: null,
                      allowedTools: permitted.filter((x) => x.readOnly && x.entitled).map((x) => x.name), rateLimitPerMin: 60, expiresOn: '' }}
                    submitLabel={t('mcp.oauth.allow')} pending={approve.pending} error={approve.error} onSubmit={(v) => void approve.run(v)} />
                  <div className="row" style={{ justifyContent: 'flex-end' }}>
                    <button type="button" className="btn btn-ghost" disabled={deny.pending} onClick={() => void deny.run()}>{t('mcp.oauth.deny')}</button>
                  </div>
                  {deny.error && <Notice tone="danger">{deny.error}</Notice>}
                </>
              )}
            </div>
          )}
        </LoadState>
      </div>
    </ModuleGate>
  );
}

export default function McpConsentPage() {
  return <Suspense fallback={null}><Consent /></Suspense>;
}
