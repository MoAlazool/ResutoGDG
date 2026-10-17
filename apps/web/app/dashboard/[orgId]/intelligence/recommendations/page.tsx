'use client';
import type { RecommendationsResponse, RecommendedItem } from '@resuto/contracts';
import { Badge, Card, Skeleton } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/format';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { ApiErrorNotice, BranchSelect, Empty, IntelShell, fmtNum, useBranch } from '../_components/IntelShell';

function RecList({ items }: { items: RecommendedItem[] }) {
  const { t, locale } = useT();
  return (
    <ol style={{ margin: 0, paddingInlineStart: 20, display: 'grid', gap: 8 }}>
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

export default function RecommendationsPage() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { branchId, setBranchId } = useBranch();
  const { data, error, loading, reload } = useApi<RecommendationsResponse>(branchId ? `/o/${org.id}/intelligence/recommendations?branchId=${branchId}&k=5` : null);
  return (
    <IntelShell>
      <div style={{ maxWidth: 320 }}><BranchSelect value={branchId} onChange={setBranchId} /></div>
      {loading && !data ? <div className="card"><Skeleton lines={6} /></div>
        : error ? <ApiErrorNotice error={error} onRetry={reload} />
          : !data?.stats.baskets ? <Empty title={t('intelligence.rec.empty')} />
            : (
              <div className="stack">
                <p className="fine">{t('intelligence.rec.stats', { baskets: data.stats.baskets })}</p>
                <div className="grid grid-3">
                  {data.items.map((it) => (
                    <div key={it.productId} style={{ minWidth: 0 }}>
                      <Card title={<span dir="auto">{pick(locale, it.name, it.nameAr)}</span>}>
                        <div className="overline" style={{ marginBlockEnd: 8 }}>{t('intelligence.rec.title')}</div>
                        {it.frequentlyBoughtWith.length ? <RecList items={it.frequentlyBoughtWith} /> : <span className="muted">—</span>}
                      </Card>
                    </div>
                  ))}
                  <div style={{ minWidth: 0 }}><Card warm title={t('intelligence.rec.popular')}><RecList items={data.popular} /></Card></div>
                </div>
              </div>
            )}
    </IntelShell>
  );
}
