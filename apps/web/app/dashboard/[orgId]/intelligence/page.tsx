'use client';
import { useState } from 'react';
import { formatNumber, renderInsight, type Insight } from '@resuto/contracts';
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
      {message && <div className="mbe-12"><Notice tone="ok">{message}</Notice></div>}
      {(refresh.error || update.error) && <div className="mbe-12"><Notice tone="danger">{refresh.error ?? update.error}</Notice></div>}
      {loading && !data ? <div className="card"><Skeleton lines={5} /></div>
        : error ? <ApiErrorNotice error={error} onRetry={reload} />
          : !items.length ? <Empty title={t('intelligence.insights.empty')} body={t('intelligence.insights.emptyBody')} />
            : (
              <ul className="stack" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {items.map((i) => (
                  <li key={i.id} className="card rise" style={{ padding: 18 }}>
                    <div className="spread items-start">
                      <div className="stack" style={{ gap: 6, minWidth: 0, flex: '1 1 280px' }}>
                        <div className="row gap-8">
                          <Badge tone={SEVERITY_TONE[i.severity]}>{t(`intelligence.severity.${i.severity}`)}</Badge>
                          <Badge>{t(`intelligence.method.${i.method}`)}</Badge>
                          {i.status !== 'new' && <Badge tone={i.status === 'resolved' ? 'ok' : undefined}>{t(`intelligence.status.${i.status}`)}</Badge>}
                          <span className="fine">{dateTime(i.createdAt, locale, org.timezone)}</span>
                          {i.refreshedAt && <span className="fine">{t('intelligence.insights.updated', { at: dateTime(i.refreshedAt, locale, org.timezone) })}</span>}
                        </div>
                        <InsightText insight={i} />
                      </div>
                      {(i.status === 'new' || i.status === 'seen') && (
                        <div className="row gap-6">
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

/**
 * Title, body and evidence in the reader's language (FT-15): rendered from the insight's template key and params with
 * the shared Western-digit formatters. Older insights without a template fall back to the stored English text and a
 * plain label/value list of their evidence (never raw JSON).
 */
function InsightText({ insight }: { insight: Insight }) {
  const { t, locale } = useT();
  const rendered = renderInsight(insight.templateKey, insight.params, locale === 'ar' ? 'ar' : 'en');
  const evidence = rendered?.evidence ?? Object.entries(insight.evidence ?? {})
    .filter(([k, v]) => k !== 'rule' && (typeof v === 'number' || typeof v === 'string') && !/Ids?$/.test(k))
    .map(([k, v]) => ({ label: k.replace(/([A-Z])/g, ' $1').toLowerCase(), value: typeof v === 'number' ? formatNumber(v, locale, { maximumFractionDigits: 2 }) : String(v) }));
  return (
    <>
      <strong style={{ fontSize: 16 }} dir="auto">{rendered?.title ?? insight.title}</strong>
      <p className="m-0" dir="auto">{rendered?.body ?? insight.body}</p>
      {evidence.length > 0 && (
        <details>
          <summary className="fine cursor-pointer">{t('intelligence.insights.evidence')}</summary>
          <dl className="evidence-list" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '4px 14px', margin: '8px 0 0', fontSize: 13,
            background: 'var(--surface-warm)', padding: 10, borderRadius: 8 }}>
            {evidence.map((e) => (
              <div key={e.label} style={{ display: 'contents' }}>
                <dt className="muted">{e.label}</dt>
                <dd className="num m-0"><bdi>{e.value}</bdi></dd>
              </div>
            ))}
          </dl>
          <p className="fine" style={{ marginBlockEnd: 0 }}>{t(`intelligence.method.explain.${insight.method}`)}</p>
        </details>
      )}
    </>
  );
}
