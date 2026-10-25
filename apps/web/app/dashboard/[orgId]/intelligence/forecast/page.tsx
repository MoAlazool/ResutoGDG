'use client';
import { useState } from 'react';
import type { ForecastResponse, ItemForecast } from '@resuto/contracts';
import { Badge, Card, Notice, SelectField, Skeleton } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/format';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { forecastReason } from '@/lib/vocab';
import { ForecastChart, Legend } from '../_components/charts';
import { ApiErrorNotice, Empty, IntelShell, fmtNum, fmtPct, useBranch } from '../_components/IntelShell';

function ItemCard({ item }: { item: ItemForecast }) {
  const { t, locale, dir } = useT();
  const history = item.history.slice(-28);
  const filled: Array<{ date: string; value: number }> = [];
  if (history.length) {
    const byDate = new Map(item.history.map((h) => [h.date, h.quantity]));
    const end = new Date(`${item.coverage.end}T00:00:00Z`);
    for (let i = 27; i >= 0; i--) {
      const d = new Date(end); d.setUTCDate(d.getUTCDate() - i);
      const iso = d.toISOString().slice(0, 10);
      if (iso >= item.coverage.start) filled.push({ date: iso, value: byDate.get(iso) ?? 0 });
    }
  }
  const sum = (k: 'yhat' | 'lower' | 'upper') => item.forecast.reduce((s, p) => s + p[k], 0);
  const name = pick(locale, item.name, item.nameAr);
  const level = Math.round(item.interval.level * 100);
  return (
    <Card title={name} actions={<Badge tone="info">{t(`intelligence.model.${item.model}`)}</Badge>}>
      <p className="muted mbs-0">
        {t('intelligence.forecast.total', { days: item.forecast.length, total: fmtNum(sum('yhat'), locale), lower: fmtNum(sum('lower'), locale), upper: fmtNum(sum('upper'), locale) })}
      </p>
      <ForecastChart history={filled} forecast={item.forecast} rtl={dir === 'rtl'}
        label={`${name}: ${t('intelligence.forecast.total', { days: item.forecast.length, total: fmtNum(sum('yhat'), locale), lower: fmtNum(sum('lower'), locale), upper: fmtNum(sum('upper'), locale) })}`} />
      <Legend items={[
        { color: 'var(--chart-4)', label: t('intelligence.forecast.history') },
        { color: 'var(--chart-1)', label: t('intelligence.forecast.prediction'), dashed: true },
        { color: 'var(--chart-1)', label: t('intelligence.forecast.interval', { level }), band: true },
      ]} />
      {item.fallbackReason && <p className="fine">{t('intelligence.forecast.fallback', { reason: forecastReason(t, item.fallbackReason) })}</p>}
      <h3 style={{ fontSize: 14, marginBlock: '14px 6px' }}>{t('intelligence.forecast.backtest', { folds: item.backtest.folds, horizon: item.backtest.horizon })}</h3>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{t('intelligence.forecast.model')}</th><th className="text-end">MAE</th><th className="text-end">RMSE</th><th className="text-end">WAPE</th></tr></thead>
          <tbody>
            {item.candidates.map((c) => (
              <tr key={c.model}>
                <td>{t(`intelligence.model.${c.model}`)} {c.model === item.model && <Badge tone="ok">{t('intelligence.forecast.chosen')}</Badge>}
                  {c.excluded && <div className="fine">{forecastReason(t, c.excluded)}</div>}</td>
                <td className="num text-end">{fmtNum(c.metrics?.mae, locale, 2)}</td>
                <td className="num text-end">{fmtNum(c.metrics?.rmse, locale, 2)}</td>
                <td className="num text-end">{fmtPct(c.metrics?.wape, locale)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine">{t('intelligence.forecast.coverage', { days: item.coverage.days, nonZero: item.coverage.nonZeroDays, start: item.coverage.start, end: item.coverage.end })}</p>
      <details>
        <summary className="fine cursor-pointer">{t('intelligence.forecast.table')}</summary>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{t('intelligence.forecast.date')}</th><th className="text-end">{t('intelligence.forecast.prediction')}</th><th className="text-end">{t('intelligence.forecast.interval', { level })}</th></tr></thead>
            <tbody>{item.forecast.map((p) => (
              <tr key={p.date}><td>{p.date}{p.isWeekend ? ' ·W' : ''}{p.isRamadan ? ' ☾' : ''}</td><td className="num text-end">{fmtNum(p.yhat, locale)}</td>
                <td className="num text-end">{fmtNum(p.lower, locale)}–{fmtNum(p.upper, locale)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      </details>
    </Card>
  );
}

export default function ForecastPage() {
  const { t } = useT();
  const { org } = useOrg();
  const { branchId } = useBranch();
  const [horizon, setHorizon] = useState(14);
  const { data, error, loading, reload } = useApi<ForecastResponse>(branchId ? `/o/${org.id}/intelligence/forecast?branchId=${branchId}&horizon=${horizon}&top=5` : null);
  return (
    <IntelShell>
      <div className="form-row" style={{ maxWidth: 560 }}>
        <SelectField label={t('intelligence.forecast.horizon')} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
          {[7, 14].map((h) => <option key={h} value={h}>{h}</option>)}
        </SelectField>
      </div>
      {loading && !data ? <div className="card"><Skeleton lines={6} /></div>
        : error ? <ApiErrorNotice error={error} onRetry={reload} />
          : !data?.items.length ? <Empty title={t('intelligence.forecast.empty')} body={t('intelligence.forecast.emptyBody')} />
            : (
              <div className="stack">
                {data.isSyntheticData
                  ? <Notice tone="warn"><Badge tone="warn">{t('intelligence.synthetic.badge')}</Badge> {t('intelligence.synthetic.forecast')} {data.calendar.ramadan.length ? t('intelligence.forecast.ramadan') : ''}</Notice>
                  : <Notice>{t('intelligence.computedFrom')} {data.calendar.ramadan.length ? t('intelligence.forecast.ramadan') : ''}</Notice>}
                <div className="grid grid-2">{data.items.map((it) => <div className="min-w-0" key={it.productId}><ItemCard item={it} /></div>)}</div>
              </div>
            )}
    </IntelShell>
  );
}
