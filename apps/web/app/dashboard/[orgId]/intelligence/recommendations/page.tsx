'use client';
// Insights › Recommendations: dishes often bought together (association rules over the branch's baskets; popular
// dishes when there is not enough data, labelled so).
import type { RecommendationsResponse, RecommendedItem } from '@resuto/contracts';
import { Badge, Card, ProvenanceBadge, Skeleton } from '@resuto/ui';
import { InsightsShell } from '@/components/insights/InsightsShell';
import s from '@/components/insights/insights.module.css';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/format';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { ApiErrorNotice, Empty, fmtNum, useBranch } from '../_components/intel';

function RecList({ items }: { items: RecommendedItem[] }) {
  const { t, locale } = useT();
  return (
    <ol className={s.stackList}>
      {items.map((r) => (
        <li key={r.productId}>
          <strong dir="auto">{pick(locale, r.name, r.nameAr)}</strong>{' '}
          {r.source === 'association' && r.confidence !== undefined
            ? <span className="fine">{t('intelligence.rec.confidence', { pct: fmtNum(r.confidence * 100, locale, 0), lift: fmtNum(r.lift ?? null, locale, 2) })}</span>
            : <Badge>{t('intelligence.rec.fallback')}</Badge>}
        </li>
      ))}
    </ol>
  );
}

function Recommendations() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { branchId } = useBranch();
  const { data, error, loading, reload } = useApi<RecommendationsResponse>(branchId ? `/o/${org.id}/intelligence/recommendations?branchId=${branchId}&k=5` : null);
  return (
    <>
      {loading && !data ? <div className="card"><Skeleton lines={6} /></div>
        : error ? <ApiErrorNotice error={error} onRetry={reload} />
          : !data?.stats.baskets ? <Empty title={t('intelligence.rec.empty')} />
            : (
              <div className="stack">
                <p className="fine">{t('intelligence.rec.stats', { baskets: data.stats.baskets })} <ProvenanceBadge provenance="estimated" /></p>
                <div className="grid grid-3">
                  {data.items.map((it) => (
                    <div className="min-w-0" key={it.productId}>
                      <Card title={<span dir="auto">{pick(locale, it.name, it.nameAr)}</span>}>
                        <div className={`overline ${s.recLabel}`}>{t('intelligence.rec.title')}</div>
                        {it.frequentlyBoughtWith.length ? <RecList items={it.frequentlyBoughtWith} /> : <span className="muted">—</span>}
                      </Card>
                    </div>
                  ))}
                  <div className="min-w-0"><Card warm title={t('intelligence.rec.popular')}><RecList items={data.popular} /></Card></div>
                </div>
              </div>
            )}
    </>
  );
}

export default function RecommendationsPage() {
  return <InsightsShell section="recommendations"><Recommendations /></InsightsShell>;
}
