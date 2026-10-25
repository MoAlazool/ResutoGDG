'use client';
// Insights › Customers, intelligence part (formerly /intelligence/customers, which now redirects here): RFM segments
// and churn risk. Rule-based segments and a model (or a labelled heuristic) for churn: estimates, said so on screen.
import { useState } from 'react';
import type { ChurnResponse, SegmentKey, SegmentMember, SegmentsResponse } from '@resuto/contracts';
import { Badge, BarList, Card, DataTable, Notice, ProvenanceBadge, Skeleton } from '@resuto/ui';
import { money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { ApiErrorNotice, Empty, fmtNum } from '../../intelligence/_components/intel';

function Members({ segment }: { segment: SegmentKey }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { data, error, loading } = useApi<{ items: SegmentMember[]; total: number }>(`/o/${org.id}/intelligence/segments/${segment}/customers?limit=50`);
  if (loading && !data) return <Skeleton lines={4} />;
  if (error) return <ApiErrorNotice error={error} />;
  return (
    <DataTable rows={data?.items ?? []} rowKey={(r) => r.customerId} empty={<Empty title={t('intelligence.segments.empty')} />} columns={[
      { key: 'name', header: t('intelligence.customer'), render: (r) => <span dir="auto">{r.displayName ?? '—'}</span> },
      { key: 'rfm', header: 'R·F·M', render: (r) => <span className="num">{r.r}·{r.f}·{r.m}</span> },
      { key: 'recency', header: t('intelligence.recency'), render: (r) => t('intelligence.daysAgo', { n: Math.round(r.recencyDays) }) },
      { key: 'orders', header: t('intelligence.orders'), align: 'end', render: (r) => <span className="num">{r.frequency}</span> },
      { key: 'spend', header: t('intelligence.spend'), align: 'end', render: (r) => <span className="num">{money(r.monetaryMinor, org.currency, locale)}</span> },
    ]} />
  );
}

/** Segments and churn: only for roles with ai:use on a plan with the intelligence module (the caller checks). */
export function SegmentsPanel() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const canList = can('customers:read');
  const [selected, setSelected] = useState<SegmentKey | null>(null);
  const segments = useApi<SegmentsResponse>(`/o/${org.id}/intelligence/segments`);
  const churn = useApi<ChurnResponse>(canList ? `/o/${org.id}/intelligence/churn?limit=25` : null);
  const auc = (churn.data?.evaluation as { rocAuc?: number } | undefined)?.rocAuc;
  return (
    <div className="stack gap-16" id="segments">
      <div className="grid grid-2">
        <div className="min-w-0"><Card title={t('intelligence.segments.title')} actions={<ProvenanceBadge provenance="estimated" />}>
          {segments.loading && !segments.data ? <Skeleton lines={6} />
            : segments.error ? <ApiErrorNotice error={segments.error} onRetry={segments.reload} />
              : !segments.data?.totalCustomers ? <Empty title={t('intelligence.segments.empty')} />
                : (
                  <div className="stack">
                    <span className="muted">{t('intelligence.segments.total', { n: segments.data.totalCustomers })}</span>
                    <BarList label={t('intelligence.segments.title')} selected={selected} onSelect={canList ? (k) => setSelected(k as SegmentKey) : undefined} palette="categorical"
                      rows={segments.data.segments.map((s) => ({ key: s.key, label: t(`intelligence.segment.${s.key}`), value: s.count }))} />
                    <p className="fine">{t('intelligence.segments.rules')}</p>
                  </div>
                )}
        </Card></div>
        <div className="min-w-0"><Card title={t('intelligence.churn.title')} actions={<ProvenanceBadge provenance="estimated" />}>
          {!canList ? <Notice>{t('intelligence.segments.noAccess')}</Notice>
            : churn.loading && !churn.data ? <Skeleton lines={6} />
              : churn.error ? <ApiErrorNotice error={churn.error} onRetry={churn.reload} />
                : (
                  <div className="stack">
                    <Notice tone={churn.data?.isHeuristic ? 'warn' : 'info'}>
                      {churn.data?.isHeuristic ? t('intelligence.churn.heuristic', { reason: churn.data.reason ?? '' })
                        : t('intelligence.churn.model', { auc: fmtNum(auc, locale, 2) })}
                    </Notice>
                    <DataTable rows={churn.data?.customers ?? []} rowKey={(r) => r.customerId} empty={<Empty title={t('intelligence.segments.empty')} />} columns={[
                      { key: 'name', header: t('intelligence.customer'), render: (r) => <span dir="auto">{r.displayName ?? '—'}</span> },
                      { key: 'risk', header: t('intelligence.risk'), render: (r) => <Badge tone={r.band === 'high' ? 'danger' : r.band === 'medium' ? 'warn' : 'ok'}><span className="num">{Math.round(r.risk * 100)}%</span></Badge> },
                      { key: 'recency', header: t('intelligence.recency'), render: (r) => t('intelligence.daysAgo', { n: Math.round(r.recencyDays) }) },
                      { key: 'spend', header: t('intelligence.spend'), align: 'end', render: (r) => <span className="num">{money(r.monetaryMinor, churn.data!.currency, locale)}</span> },
                    ]} />
                  </div>
                )}
        </Card></div>
      </div>
      {selected && canList && (
        <Card title={`${t('intelligence.segments.members')}: ${t(`intelligence.segment.${selected}`)}`}><Members segment={selected} /></Card>
      )}
    </div>
  );
}
