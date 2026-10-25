'use client';
// Analytics → Guests (VS-27): the ratings guests leave after paying — average, per-score counts, where they paid and
// their latest comments. Ratings carry no guest identity.
import type { AnalyticsMeta, RatingsSummary } from '@resuto/contracts';
import { BarList, EmptyState, Skeleton, Stat } from '@resuto/ui';
import { LoadError, MetaPanel, qs, Section, useFormat, type Period } from '@/components/charts/insights';
import a from './analytics.module.css';
import { formatWhen } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';

const SOURCES = new Set(['table', 'share', 'web']);

export function RatingsPanel({ period, branchId }: { period: Period; branchId: string }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const f = useFormat();
  const { data, error, loading, reload } = useApi<RatingsSummary & { meta: AnalyticsMeta }>(
    `/o/${org.id}/analytics/ratings${qs({ from: period.from, to: period.to, branchId })}`);
  if (error) return <LoadError error={error} retry={reload} />;
  if (loading && !data) return <div className="card"><Skeleton lines={6} /></div>;
  if (!data) return null;
  const score = (v: number | null) => (v === null ? '—' : f.num(v));
  const outOf = (v: number | null) => (v === null ? undefined : t('insights.ratings.outOf'));
  const source = (s: string) => (SOURCES.has(s) ? t(`insights.ratings.source.${s}`) : s);
  return (
    <div className="stack gap-16">
      <div>
        <h2 className={a.title}>{t('insights.ratings.title')}</h2>
        <p className={`muted ${a.subtitle}`}>{t('insights.ratings.subtitle')}</p>
      </div>
      {data.count === 0 ? <EmptyState title={t('insights.ratings.empty')} /> : (
        <>
          <div className="grid grid-4">
            <Stat label={t('insights.ratings.overall')} value={score(data.averages.overall)} hint={outOf(data.averages.overall)} />
            <Stat label={t('insights.ratings.count')} value={f.num(data.count)} />
            <Stat label={t('insights.ratings.food')} value={score(data.averages.food)} hint={outOf(data.averages.food)} />
            <Stat label={t('insights.ratings.service')} value={score(data.averages.service)} hint={outOf(data.averages.service)} />
            <Stat label={t('insights.ratings.speed')} value={score(data.averages.speed)} hint={outOf(data.averages.speed)} />
            <Stat label={t('insights.ratings.value')} value={score(data.averages.value)} hint={outOf(data.averages.value)} />
          </div>
          <div className="grid grid-2">
            <Section title={t('insights.ratings.distribution')}>
              <BarList format={f.num} items={[5, 4, 3, 2, 1].map((n) => ({ key: String(n), label: t('insights.ratings.stars', { score: n }), value: data.distribution[n - 1] ?? 0 }))} />
            </Section>
            <Section title={t('insights.ratings.bySource')}>
              <BarList format={f.num} empty={t('insights.empty.none')}
                items={data.bySource.map((s) => ({ key: s.source, label: source(s.source), value: s.count, hint: s.average === null ? undefined : `${score(s.average)} / 5` }))} />
            </Section>
          </div>
          <Section title={t('insights.ratings.comments')}>
            {data.comments.length === 0 ? <p className="muted m-0">{t('insights.ratings.noComments')}</p> : (
              <ul className={`stack ${a.comments}`}>
                {data.comments.map((c, i) => (
                  <li key={`${c.at}-${i}`} className={a.comment}>
                    <div className="fine">{t('insights.ratings.stars', { score: c.overall })} · {source(c.source)} · {formatWhen(c.at, locale, org.timezone)}</div>
                    <p className={a.subtitle} dir="auto"><bdi>{c.comment}</bdi></p>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </>
      )}
      <MetaPanel meta={data.meta} />
    </div>
  );
}
