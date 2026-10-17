'use client';
import { useEffect, useState } from 'react';
import { DataTable, Notice, SelectField, useAction } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { LoadState, McpPage, OutcomeBadge, type McpCall, type McpClient } from '../_components/shared';

const OUTCOMES = ['ok', 'approval_required', 'invalid_input', 'denied', 'rate_limited', 'error'] as const;

export default function McpCallsPage() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [outcome, setOutcome] = useState('');
  const [clientId, setClientId] = useState('');
  const clients = useApi<{ items: McpClient[] }>(`/o/${org.id}/mcp/clients`);
  const qs = new URLSearchParams({ limit: '50', ...(outcome ? { outcome } : {}), ...(clientId ? { clientId } : {}) }).toString();
  const first = useApi<{ items: McpCall[]; nextCursor: string | null }>(`/o/${org.id}/mcp/calls?${qs}`);
  const [more, setMore] = useState<McpCall[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  useEffect(() => { setMore([]); setCursor(first.data?.nextCursor ?? null); }, [first.data]);
  const loadMore = useAction(async () => {
    if (!cursor) return;
    const page = await session.call<{ items: McpCall[]; nextCursor: string | null }>(`/o/${org.id}/mcp/calls?${qs}&cursor=${cursor}`);
    setMore((m) => [...m, ...page.items]);
    setCursor(page.nextCursor);
  });
  const rows = [...(first.data?.items ?? []), ...more];

  return (
    <McpPage tab="calls">
      <div className="form-row" style={{ maxWidth: 560 }}>
        <SelectField label={t('mcp.col.outcome')} value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <option value="">{t('mcp.calls.allOutcomes')}</option>
          {OUTCOMES.map((o) => <option key={o} value={o}>{t(`mcp.outcome.${o}`)}</option>)}
        </SelectField>
        <SelectField label={t('mcp.col.client')} value={clientId} onChange={(e) => setClientId(e.target.value)}>
          <option value="">{t('mcp.calls.allClients')}</option>
          {(clients.data?.items ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </SelectField>
      </div>
      <LoadState loading={first.loading} error={first.error} retry={first.reload}>
        <DataTable rows={rows} rowKey={(r) => r.id} empty={<p className="muted" style={{ margin: 0 }}>{t('mcp.calls.empty')}</p>} columns={[
          { key: 'time', header: t('mcp.col.time'), render: (r) => <span className="num">{dateTime(r.createdAt, locale, org.timezone)}</span> },
          { key: 'client', header: t('mcp.col.client'), render: (r) => <span>{r.clientName} <code className="fine" dir="ltr">{r.keyPrefix}…</code></span> },
          { key: 'tool', header: t('mcp.col.tool'), render: (r) => <code dir="ltr">{r.tool}</code> },
          { key: 'outcome', header: t('mcp.col.outcome'), render: (r) => <OutcomeBadge outcome={r.outcome} /> },
          { key: 'via', header: t('mcp.col.via'), render: (r) => t(`mcp.via.${r.via}`) },
          { key: 'ms', header: t('mcp.col.duration'), align: 'end', render: (r) => <span className="num">{r.durationMs ?? '—'} ms</span> },
          { key: 'err', header: t('mcp.col.error'), render: (r) => r.errorCode
            ? <span className="fine" dir="ltr" title={r.error ?? undefined}>{r.errorCode}</span> : '' },
        ]} />
        {loadMore.error && <Notice tone="danger">{loadMore.error}</Notice>}
        {cursor && (
          <div className="row" style={{ justifyContent: 'center', marginBlockStart: 14 }}>
            <button type="button" className="btn btn-ghost" disabled={loadMore.pending} onClick={() => void loadMore.run()}>
              {loadMore.pending ? t('state.loading') : t('mcp.calls.more')}
            </button>
          </div>
        )}
      </LoadState>
    </McpPage>
  );
}
