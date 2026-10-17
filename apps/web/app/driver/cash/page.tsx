'use client';
import type { DeliveryJobView } from '@resuto/contracts';
import { EmptyState, Notice, Skeleton } from '@resuto/ui';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { useDriver } from '../_lib/driver-context';
import { JobCard } from '../_lib/job-card';
import s from '../driver.module.css';

interface CashSummary {
  currency: string;
  onHandMinor: number;
  toCollectMinor: number;
  collectedJobs: DeliveryJobView[];
  toCollectJobs: DeliveryJobView[];
  settlements: Array<{ id: string; amountMinor: number; currency: string; jobCount: number; note: string | null; createdAt: string }>;
}

/** Cash the driver carries (collected COD not yet handed over), cash still to collect, and past handovers. */
export default function DriverCashPage() {
  const { t, locale } = useT();
  const { base } = useDriver();
  const cash = useApi<CashSummary>(`${base}/me/cash`, { pollMs: 30_000 });
  if (cash.loading && !cash.data) return <Skeleton lines={6} />;
  if (cash.error) return <Notice tone="danger">{cash.error.message}</Notice>;
  const c = cash.data!;
  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>{t('driver.cash.title')}</h1>
      <div className={s.row2}>
        <div className={s.stat}><span>{t('driver.cash.onHand')}</span><strong>{money(c.onHandMinor, c.currency, locale)}</strong></div>
        <div className={s.stat}><span>{t('driver.cash.toCollect')}</span><strong>{money(c.toCollectMinor, c.currency, locale)}</strong></div>
      </div>
      {c.onHandMinor > 0 && <Notice>{t('driver.cash.handoverHint')}</Notice>}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>{t('driver.cash.collected')}</h2>
        {c.collectedJobs.length ? c.collectedJobs.map((j) => <JobCard key={j.id} job={j} />) : <div className="card"><EmptyState title={t('driver.cash.none')} /></div>}
      </section>
      {!!c.toCollectJobs.length && (
        <section className={s.section}>
          <h2 className={s.sectionTitle}>{t('driver.cash.toCollect')}</h2>
          {c.toCollectJobs.map((j) => <JobCard key={j.id} job={j} />)}
        </section>
      )}
      <section className={s.section}>
        <h2 className={s.sectionTitle}>{t('driver.cash.settlements')}</h2>
        {c.settlements.length ? c.settlements.map((x) => (
          <div key={x.id} className={s.detailBlock}>
            <div className="spread"><strong>{money(x.amountMinor, x.currency, locale)}</strong><span className="muted">{dateTime(x.createdAt, locale)}</span></div>
            <span className="fine">{t('driver.cash.settlementJobs', { n: x.jobCount })}{x.note ? ` · ${x.note}` : ''}</span>
          </div>
        )) : <p className="muted">{t('driver.cash.noSettlements')}</p>}
      </section>
    </>
  );
}
