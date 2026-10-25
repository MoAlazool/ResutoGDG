'use client';
// Funnel and Retention tabs of Insights (21-CRM, plan §6.7). Loaded on demand (next/dynamic) by the analytics page, so
// the chart code ships only to staff who open these tabs. Charts come from the shared chart kit (FunnelChart,
// LineChart); the cohort grid reuses its tokens. Every step shows its data source and how complete it is.
import type { AnalyticsMeta, FunnelReport, FunnelStep, RetentionReport } from '@resuto/contracts';
import { Badge, DataTable, FunnelChart, LineChart, Notice, Skeleton, Stat } from '@resuto/ui';
import { CohortHeatmap } from './CohortHeatmap';
import { LoadError, MetaPanel, qs, Section, useFormat, type Period } from '@/components/charts/insights';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import './crm.css';

interface PanelProps { period: Period; branchId: string }
const TONE = { complete: 'ok', partial: 'warn', estimate: 'info', unavailable: 'neutral' } as const;

function useReport<T>(path: 'funnel' | 'retention', props: PanelProps) {
  const { org } = useOrg();
  return useApi<T & { meta: AnalyticsMeta }>(`/o/${org.id}/analytics/${path}${qs({ from: props.period.from, to: props.period.to, branchId: props.branchId })}`);
}

function Completeness({ step }: { step: FunnelStep }) {
  const { t } = useT();
  return <span data-completeness={step.completeness}><Badge tone={TONE[step.completeness]}>{t(`crm.funnel.completeness.${step.completeness}`)}</Badge></span>;
}

export function FunnelPanel(props: PanelProps) {
  const { t, locale } = useT();
  const f = useFormat();
  const { data, error, loading, reload } = useReport<FunnelReport>('funnel', props);
  if (error) return <LoadError error={error} retry={reload} />;
  if (loading && !data) return <div className="card"><Skeleton lines={6} /></div>;
  if (!data) return null;
  const measured = data.steps.filter((s) => s.value !== null);
  const since = data.beaconsSince ? new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(data.beaconsSince)) : null;
  const notes = (s: FunnelStep) => s.notes.filter((n) => n !== 'not_same_people');
  return (
    <div className="stack gap-16" data-testid="funnel-panel">
      <Notice>{t('crm.funnel.hint')}</Notice>
      <Section title={t('crm.funnel.title')}>
        <FunnelChart title={t('crm.funnel.title')} format={(n) => f.num(n)}
          steps={measured.map((s) => ({ key: s.key, label: t(`crm.funnel.step.${s.key}`), value: s.value ?? 0 }))}
          // Steps count different things: a rate above 100 % would mislead, so it is left out.
          formatRate={(x) => (x <= 1 ? f.pct(Math.round(x * 1000) / 10) : '')} rateLabel={(r) => (r ? t('crm.funnel.rate', { rate: r }) : '')} />
        <p className="fine">{since ? t('crm.funnel.since', { date: since }) : t('crm.funnel.sinceNone')} {t('crm.funnel.basis')}</p>
        <DataTable rows={data.steps} rowKey={(s) => s.key} columns={[
          { key: 'step', header: t('crm.funnel.col.step'), render: (s) => <strong>{t(`crm.funnel.step.${s.key}`)}</strong> },
          { key: 'count', header: t('crm.funnel.col.count'), align: 'end', render: (s) => (
            <span className="crm-count"><span className="num">{f.num(s.value)}</span> <span className="fine">{t(`crm.funnel.unit.${s.unit}`)}</span>
              {s.completeness === 'estimate' && s.measured !== null && <span className="fine crm-measured">{t('crm.funnel.measured', { count: s.measured })}</span>}</span>) },
          { key: 'completeness', header: t('crm.funnel.col.completeness'), render: (s) => <Completeness step={s} /> },
          { key: 'source', header: t('crm.funnel.col.source'), render: (s) => (
            <div className="crm-source">
              <code lang="en" dir="ltr">{s.source}</code>
              {notes(s).length > 0 && <ul className="crm-notes">{notes(s).map((n) => <li key={n}>{t(`crm.funnel.note.${n}`)}</li>)}</ul>}
            </div>) },
        ]} />
      </Section>
      <Section title={t('crm.funnel.cart')}>
        <p className="fine m-0">{t('crm.funnel.cartHint')}</p>
        <div className="grid grid-2 mbs-10">
          {data.cart.map((s) => <Stat key={s.key} label={t(`crm.funnel.step.${s.key}`)} value={f.num(s.value)} hint={<Completeness step={s} />} />)}
        </div>
      </Section>
      <MetaPanel meta={data.meta} />
    </div>
  );
}

export function RetentionPanel(props: PanelProps) {
  const { t, dir } = useT();
  const f = useFormat();
  const { data, error, loading, reload } = useReport<RetentionReport>('retention', props);
  if (error) return <LoadError error={error} retry={reload} />;
  if (loading && !data) return <div className="card"><Skeleton lines={6} /></div>;
  if (!data) return null;
  const points = data.repeatCurve.points.filter((p) => p.eligible > 0);
  return (
    <div className="stack gap-16" data-testid="retention-panel">
      <Section title={t('crm.retention.cohorts')}>
        <p className="fine">{t('crm.retention.cohortsHint')}</p>
        {data.cohorts.length ? <CohortHeatmap cohorts={data.cohorts} formatPct={f.pct} formatNum={(n) => f.num(n)} />
          : <p className="muted">{t('crm.retention.none')}</p>}
      </Section>
      <Section title={t('crm.retention.curve')}>
        <p className="fine">{t('crm.retention.curveHint', { count: data.repeatCurve.newCustomers })}</p>
        {points.length ? (
          <LineChart title={t('crm.retention.curve')} rtl={dir === 'rtl'} labels={points.map((p) => t('crm.retention.dayN', { d: p.day }))}
            series={[{ name: t('crm.retention.series'), values: points.map((p) => p.pct ?? 0) }]} format={f.pct}
            xLabel={t('crm.retention.day')} tableCaption={t('crm.retention.table')} />
        ) : <p className="muted">{t('crm.retention.none')}</p>}
      </Section>
      <MetaPanel meta={data.meta} />
    </div>
  );
}
