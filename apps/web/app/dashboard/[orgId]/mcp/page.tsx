'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Badge, DataTable, EmptyState } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { ClientStatus, LoadState, McpPage, type McpClient } from './_components/shared';

export default function McpClientsPage() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const router = useRouter();
  const base = `/dashboard/${org.id}/mcp`;
  const clients = useApi<{ items: McpClient[] }>(`/o/${org.id}/mcp/clients`);
  const branchName = (id: string) => {
    const b = org.branches.find((x) => x.id === id);
    return b ? (locale === 'ar' && b.nameAr ? b.nameAr : b.name) : id.slice(0, 8);
  };

  return (
    <McpPage tab="clients" actions={<Link className="btn btn-primary" href={`${base}/new`}>{t('mcp.clients.new')}</Link>}>
      <LoadState loading={clients.loading} error={clients.error} retry={clients.reload}>
        <DataTable
          rows={clients.data?.items ?? []}
          rowKey={(c) => c.id}
          onRowClick={(c) => router.push(`${base}/clients/${c.id}`)}
          empty={<EmptyState title={t('mcp.clients.empty.title')} action={<Link className="btn btn-primary" href={`${base}/new`}>{t('mcp.clients.new')}</Link>}>
            {t('mcp.clients.empty.body')}
          </EmptyState>}
          columns={[
            { key: 'name', header: t('mcp.col.name'), render: (c) => <Link href={`${base}/clients/${c.id}`}><strong>{c.name}</strong></Link> },
            { key: 'key', header: t('mcp.col.key'), render: (c) => <code dir="ltr">{c.keyPrefix}…</code> },
            { key: 'role', header: t('mcp.col.role'), render: (c) => t(`mcp.role.${c.actingRole}`) },
            { key: 'branches', header: t('mcp.col.branches'), render: (c) => c.branchIds === null ? t('mcp.branches.all')
              : c.branchIds.length <= 2 ? c.branchIds.map(branchName).join(locale === 'ar' ? '، ' : ', ') : t('mcp.branches.count', { n: c.branchIds.length }) },
            { key: 'tools', header: t('mcp.col.tools'), render: (c) => t('mcp.toolsCount', { n: c.allowedTools.length }) },
            { key: 'status', header: t('mcp.col.status'), render: (c) => <ClientStatus client={c} /> },
            { key: 'last', header: t('mcp.col.lastUsed'), render: (c) => c.lastUsedAt ? dateTime(c.lastUsedAt, locale, org.timezone) : <span className="muted">{t('mcp.never')}</span> },
            { key: 'calls', header: t('mcp.col.calls24h'), align: 'end', render: (c) => <span className="num">{c.calls24h ?? 0}</span> },
            { key: 'pending', header: t('mcp.col.pending'), align: 'end',
              render: (c) => (c.pendingApprovals ? <Badge tone="info">{c.pendingApprovals}</Badge> : <span className="muted num">0</span>) },
          ]}
        />
      </LoadState>
    </McpPage>
  );
}
