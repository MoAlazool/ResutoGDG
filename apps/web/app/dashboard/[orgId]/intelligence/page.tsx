'use client';
import { useState } from 'react';
import type { Insight } from '@resuto/contracts';
import { Badge, Notice, Skeleton, Tabs, useAction, type Tone } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { dateTime } from '@/lib/format';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { ApiErrorNotice, Empty, IntelShell } from './_components/IntelShell';

const SEVERITY_TONE: Record<Insight['severity'], Tone> = { info: 'info', opportunity: 'ok', warning: 'warn', critical: 'danger' };
type Filter = 'open' | 'all' | 'dismissed';

export default function InsightsPage() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const [filter, setFilter] = useState<Filter>('open');
  const [message, setMessage] = useState<string | null>(null);
  const path = `/o/${org.id}/intelligence/insights?limit=100${filter === 'dismissed' ? '&status=dismissed' : ''}`;
  const { data, error, loading, reload } = useApi<{ items: Insight[] }>(path);
  const items = (data?.items ?? []).filter((i) => filter !== 'open' || i.status === 'new' || i.status === 'seen');

  const refresh = useAction(async () => {
    const r = await call<{ created: number }>(`/o/${org.id}/intelligence/insights/refresh`, { method: 'POST' });
    setMessage(t('intelligence.insights.refreshed', { n: r.created }));
    await reload();
  });
  const update = useAction(async (id: string, status: 'seen' | 'acted' | 'dismissed') => {
    await call(`/o/${org.id}/intelligence/insights/${id}`, { method: 'PATCH', body: { status } });
    await reload();
  });

  return (
    <IntelShell actions={<button type="button" className="btn btn-primary" disabled={refresh.pending} onClick={() => refresh.run()}>
      {refresh.pending ? t('state.loading') : t('intelligence.insights.refresh')}</button>}>
      <Tabs<Filter> value={filter} onChange={setFilter} tabs={[
        { key: 'open', label: t('intelligence.insights.filter.open') },
        { key: 'all', label: t('intelligence.insights.filter.all') },
        { key: 'dismissed', label: t('intelligence.insights.filter.dismissed') },
      ]} />
      {message && <div style={{ marginBlockEnd: 12 }}><Notice tone="ok">{message}</Notice></div>}
      {(refresh.error || update.error) && <div style={{ marginBlockEnd: 12 }}><Notice tone="danger">{refresh.error ?? update.error}</Notice></div>}
      {loading && !data ? <div className="card"><Skeleton lines={5} /></div>
        : error ? <ApiErrorNotice error={error} onRetry={reload} />
          : !items.length ? <Empty title={t('intelligence.insights.empty')} body={t('intelligence.insights.emptyBody')} />
            : (
              <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {items.map((i) => (
                  <li key={i.id} className="card rise" style={{ padding: 18 }}>
                    <div className="spread" style={{ alignItems: 'flex-start' }}>
                      <div className="stack" style={{ gap: 6, minWidth: 0, flex: '1 1 280px' }}>
                        <div className="row" style={{ gap: 8 }}>
                          <Badge tone={SEVERITY_TONE[i.severity]}>{t(`intelligence.severity.${i.severity}`)}</Badge>
                          <Badge>{t(`intelligence.method.${i.method}`)}</Badge>
                          {i.status !== 'new' && <Badge>{t(`intelligence.status.${i.status}`)}</Badge>}
                          <span className="fine">{dateTime(i.createdAt, locale, org.timezone)}</span>
                        </div>
                        <strong style={{ fontSize: 16 }}>{i.title}</strong>
                        <p style={{ margin: 0 }} dir="auto">{i.body}</p>
                        <details>
                          <summary className="fine" style={{ cursor: 'pointer' }}>{t('intelligence.insights.evidence')}</summary>
                          <pre dir="ltr" style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--surface-warm)', padding: 10, borderRadius: 8 }}>
                            {JSON.stringify(i.evidence, null, 2)}
                          </pre>
                        </details>
                      </div>
                      {(i.status === 'new' || i.status === 'seen') && (
                        <div className="row" style={{ gap: 6 }}>
                          {i.status === 'new' && <button type="button" className="btn btn-sm btn-ghost" disabled={update.pending} onClick={() => update.run(i.id, 'seen')}>{t('intelligence.insights.seen')}</button>}
                          <button type="button" className="btn btn-sm btn-leaf" disabled={update.pending} onClick={() => update.run(i.id, 'acted')}>{t('intelligence.insights.acted')}</button>
                          <button type="button" className="btn btn-sm btn-danger" disabled={update.pending} onClick={() => update.run(i.id, 'dismissed')}>{t('intelligence.insights.dismiss')}</button>
                        </div>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
    </IntelShell>
  );
}
