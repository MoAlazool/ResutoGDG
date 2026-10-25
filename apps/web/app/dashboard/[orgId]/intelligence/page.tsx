'use client';
// Insights › Findings: what the intelligence module noticed (rules over the restaurant's data, or a model: each says
// which), to mark seen, acted on or dismissed. The status filter is part of the view (`?status=`, saved with a report).
import { formatNumber, renderInsight, type Insight } from '@resuto/contracts';
import { Badge, Notice, ProvenanceBadge, Skeleton, Tabs, useAction, type Tone } from '@resuto/ui';
import { useState } from 'react';
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import s from '@/components/insights/insights.module.css';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { ApiErrorNotice, Empty } from './_components/intel';

const SEVERITY_TONE: Record<Insight['severity'], Tone> = { info: 'info', opportunity: 'ok', warning: 'warn', critical: 'danger' };
type Filter = 'open' | 'all' | 'dismissed';

function Findings() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const { view, setParams } = useInsights();
  const filter = (view.filters.status ?? 'open') as Filter;
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
    <div className="stack">
      <div className="spread">
        <Tabs<Filter> value={filter} onChange={(v) => setParams({ status: v === 'open' ? null : v })} tabs={[
          { key: 'open', label: t('intelligence.insights.filter.open') },
          { key: 'all', label: t('intelligence.insights.filter.all') },
          { key: 'dismissed', label: t('intelligence.insights.filter.dismissed') },
        ]} />
        <button type="button" className="btn btn-primary" disabled={refresh.pending} onClick={() => refresh.run()}>
          {refresh.pending ? t('state.loading') : t('intelligence.insights.refresh')}</button>
      </div>
      {message && <Notice tone="ok">{message}</Notice>}
      {(refresh.error || update.error) && <Notice tone="danger">{refresh.error ?? update.error}</Notice>}
      {loading && !data ? <div className="card"><Skeleton lines={5} /></div>
        : error ? <ApiErrorNotice error={error} onRetry={reload} />
          : !items.length ? <Empty title={t('intelligence.insights.empty')} body={t('intelligence.insights.emptyBody')} />
            : (
              <ul className={`stack ${s.cleanList}`}>
                {items.map((i) => (
                  <li key={i.id} className={`card rise ${s.insightCard}`}>
                    <div className="spread items-start">
                      <div className={s.insightMain}>
                        <div className="row gap-8">
                          <Badge tone={SEVERITY_TONE[i.severity]}>{t(`intelligence.severity.${i.severity}`)}</Badge>
                          <Badge>{t(`intelligence.method.${i.method}`)}</Badge>
                          <ProvenanceBadge provenance={i.method === 'deterministic' ? 'live' : 'estimated'} />
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
    </div>
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
      <strong className={s.insightTitle} dir="auto">{rendered?.title ?? insight.title}</strong>
      <p className="m-0" dir="auto">{rendered?.body ?? insight.body}</p>
      {evidence.length > 0 && (
        <details>
          <summary className="fine cursor-pointer">{t('intelligence.insights.evidence')}</summary>
          <dl className={`evidence-list ${s.evidence}`}>
            {evidence.map((e) => (
              <div key={e.label} className={s.evidenceRow}>
                <dt className="muted">{e.label}</dt>
                <dd className="num m-0"><bdi>{e.value}</bdi></dd>
              </div>
            ))}
          </dl>
          <p className={`fine ${s.finePlain}`}>{t(`intelligence.method.explain.${insight.method}`)}</p>
        </details>
      )}
    </>
  );
}

export default function FindingsPage() {
  return <InsightsShell section="findings"><Findings /></InsightsShell>;
}
