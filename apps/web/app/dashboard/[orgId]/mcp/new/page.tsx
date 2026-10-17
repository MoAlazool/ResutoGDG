'use client';
import Link from 'next/link';
import { useState } from 'react';
import { assignableRoles, MCP_ACTING_ROLES, type Role } from '@resuto/contracts';
import { Card, Notice, useAction } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { CopyButton, endOfDayIso, LoadState, McpPage, ScopeForm, type CatalogTool, type McpClient, type ScopeValue } from '../_components/shared';

const DEFAULT_TOOLS = ['get_restaurant_profile', 'list_branches', 'list_orders', 'get_order', 'get_sales_summary', 'list_top_items', 'get_approval_status'];

export default function NewMcpClientPage() {
  const { t } = useT();
  const { org } = useOrg();
  const session = useSession();
  const catalog = useApi<{ items: CatalogTool[] }>(`/o/${org.id}/mcp/catalog`);
  const [created, setCreated] = useState<(McpClient & { key: string }) | null>(null);
  const roles = assignableRoles(org.role).filter((r) => (MCP_ACTING_ROLES as readonly string[]).includes(r));
  const defaultRole: Role = roles.includes('manager') ? 'manager' : roles[0] ?? 'manager';
  const create = useAction(async (v: ScopeValue) => {
    const res = await session.call<McpClient & { key: string }>(`/o/${org.id}/mcp/clients`, {
      body: { name: v.name, actingRole: v.actingRole, branchIds: v.branchIds, allowedTools: v.allowedTools,
        rateLimitPerMin: v.rateLimitPerMin, expiresAt: endOfDayIso(v.expiresOn) },
    });
    setCreated(res);
  });
  const base = `/dashboard/${org.id}/mcp`;

  if (created) {
    return (
      <McpPage tab="clients">
        <Card title={t('mcp.key.title')} warm>
          <div className="stack">
            <Notice tone="warn">{t('mcp.key.warning')}</Notice>
            <div className="row" style={{ alignItems: 'stretch' }}>
              <code dir="ltr" aria-label={t('mcp.col.key')} style={{ flex: '1 1 320px', padding: '10px 12px', borderRadius: 10, background: '#fff',
                border: '1px solid var(--line)', wordBreak: 'break-all', userSelect: 'all', fontSize: 14 }}>{created.key}</code>
              <CopyButton text={created.key} label={t('mcp.key.copy')} className="btn btn-primary" />
            </div>
            <p className="fine">{t('mcp.key.next')}</p>
            <div className="row">
              <Link className="btn btn-ghost" href={`${base}/connect`}>{t('mcp.tab.connect')}</Link>
              <Link className="btn btn-primary" href={`${base}/clients/${created.id}`} onClick={() => setCreated(null)}>{t('mcp.key.done')}</Link>
            </div>
          </div>
        </Card>
      </McpPage>
    );
  }

  return (
    <McpPage tab="clients">
      <h2>{t('mcp.form.title')}</h2>
      <LoadState loading={catalog.loading} error={catalog.error} retry={catalog.reload}>
        <ScopeForm
          catalog={catalog.data?.items ?? []}
          initial={{ name: '', actingRole: defaultRole, branchIds: null, allowedTools: DEFAULT_TOOLS, rateLimitPerMin: 60, expiresOn: '' }}
          submitLabel={t('mcp.form.create')}
          pending={create.pending}
          error={create.error}
          onSubmit={(v) => void create.run(v)}
        />
      </LoadState>
    </McpPage>
  );
}
