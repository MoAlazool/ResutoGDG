'use client';
// Insights › Research: offline evaluations of the models on synthetic data (sandbox), never this restaurant's figures.
import type { ResearchModel } from '@resuto/contracts';
import { Badge, Card, Skeleton } from '@resuto/ui';
import { InsightsShell } from '@/components/insights/InsightsShell';
import s from '@/components/insights/insights.module.css';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { ApiErrorNotice, Empty, fmtNum } from '../_components/intel';

const KEYS: Record<string, string[]> = {
  demand_forecast: ['mae', 'rmse', 'wape', 'interval80Coverage'],
  churn: ['rocAuc', 'averagePrecision', 'brier'],
  recommendation: ['precision@5', 'recall@5', 'ndcg@5', 'hitRate@5'],
};

function Metrics({ task, metrics, baseline }: { task: string; metrics: any; baseline: any }) {
  const { t, locale } = useT();
  if (task === 'routing') {
    const rows = Object.entries(metrics.dispatch ?? {}) as Array<[string, any]>;
    return (
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Stops</th><th className="text-end">km</th><th className="text-end">{t('intelligence.research.baseline')} km</th>
          <th className="text-end">Late stops</th><th className="text-end">ms</th></tr></thead>
        <tbody>{rows.map(([bucket, m]) => (
          <tr key={bucket}><td>{bucket}</td><td className="num text-end">{fmtNum(m.meanDistanceKm, locale, 2)}</td>
            <td className="num text-end">{fmtNum(baseline?.dispatch?.[bucket]?.meanDistanceKm, locale, 2)}</td>
            <td className="num text-end">{fmtNum(m.meanViolations, locale, 2)}</td>
            <td className="num text-end">{fmtNum(m.meanComputationMs, locale, 2)}</td></tr>
        ))}</tbody>
      </table></div>
    );
  }
  if (task === 'customer_segmentation') {
    const rows = Object.entries(metrics.observedChurnRateBySegment ?? {}) as Array<[string, any]>;
    return (
      <div className="table-wrap"><table className="data">
        <thead><tr><th>Segment</th><th className="text-end">n</th><th className="text-end">60-day churn</th></tr></thead>
        <tbody>{rows.map(([seg, v]) => (
          <tr key={seg}><td>{t(`intelligence.segment.${seg}`)}</td><td className="num text-end">{v.customers}</td>
            <td className="num text-end">{fmtNum(v.churnRate * 100, locale, 1)}%</td></tr>
        ))}</tbody>
      </table></div>
    );
  }
  const keys = (KEYS[task] ?? Object.keys(metrics)).filter((k) => typeof metrics[k] === 'number');
  return (
    <dl className="grid grid-4 m-0">
      {keys.map((k) => (
        <div key={k}>
          <dt className="fine">{k}</dt>
          <dd className={`num ${s.metricValue}`}>{fmtNum(metrics[k], locale, 3)}</dd>
          {typeof baseline?.[k] === 'number' && <dd className="fine m-0">{t('intelligence.research.baseline')}: {fmtNum(baseline[k], locale, 3)}</dd>}
        </div>
      ))}
    </dl>
  );
}

function Research() {
  const { t } = useT();
  const { org } = useOrg();
  const { data, error, loading, reload } = useApi<{ notice: string; models: ResearchModel[] }>(`/o/${org.id}/intelligence/research`);
  const tasks = [...new Set((data?.models ?? []).map((m) => m.task))];
  return (
    <>
      <div role="note" className="card card-sandbox is-strong mbe-16">
        <div className="row"><Badge tone="sandbox">{t('intelligence.research.synthetic')}</Badge></div>
        <p className={s.finePlain}>{t('intelligence.research.notice')}</p>
        {data?.notice && <p className="fine sandbox-ink" dir="ltr">{data.notice}</p>}
      </div>
      {loading && !data ? <div className="card"><Skeleton lines={6} /></div>
        : error ? <ApiErrorNotice error={error} onRetry={reload} />
          : !data?.models.length ? <Empty title={t('intelligence.research.empty')} />
            : tasks.map((task) => (
              <section key={task} className={s.researchSection}>
                <h2>{t(`intelligence.task.${task}`)}</h2>
                <div className="stack">
                  {data.models.filter((m) => m.task === task).map((m) => (
                    <Card key={m.id} title={<span>{m.name} <span className="fine">{m.version}</span></span>} actions={<Badge tone="sandbox">{t('intelligence.research.synthetic')}</Badge>}>
                      <p className="muted mbs-0">{m.algorithm}</p>
                      {m.evaluations.map((e) => (
                        <div key={`${e.runId}-${e.split}`} className="stack gap-8 mbe-12">
                          <div className="row gap-8">
                            <Badge>{t('intelligence.research.split')}: {e.split}</Badge>
                            <span className="fine">{t('intelligence.research.run')}: {e.runId}</span>
                          </div>
                          {e.split === 'test' && <Metrics task={task} metrics={e.metrics} baseline={e.baselineMetrics} />}
                          {e.notes && <p className="fine m-0" dir="ltr">{e.notes}</p>}
                        </div>
                      ))}
                    </Card>
                  ))}
                </div>
              </section>
            ))}
    </>
  );
}

export default function ResearchPage() {
  return <InsightsShell section="research"><Research /></InsightsShell>;
}
