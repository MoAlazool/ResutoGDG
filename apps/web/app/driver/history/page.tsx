'use client';
import { useCallback, useEffect, useState } from 'react';
import type { DeliveryJobView } from '@resuto/contracts';
import { EmptyState, Notice, Skeleton } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useDriver } from '../_lib/driver-context';
import { JobCard } from '../_lib/job-card';
import s from '../driver.module.css';

/** Past deliveries (delivered, failed, cancelled), newest first, with cursor paging. */
export default function DriverHistoryPage() {
  const { t } = useT();
  const { base, call } = useDriver();
  const [items, setItems] = useState<DeliveryJobView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (next?: string | null) => {
    setLoading(true);
    setError(null);
    try {
      const page = await call<{ items: DeliveryJobView[]; nextCursor: string | null }>(`${base}/history?limit=20${next ? `&cursor=${encodeURIComponent(next)}` : ''}`);
      setItems((prev) => (next ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [base, call]);

  useEffect(() => { void load(null); }, [load]);

  return (
    <>
      <h1 style={{ fontSize: 22, margin: 0 }}>{t('driver.history.title')}</h1>
      {error && <Notice tone="danger">{error} <button className="btn btn-sm" onClick={() => void load(null)}>{t('action.retry')}</button></Notice>}
      {loading && !items.length ? <Skeleton lines={5} /> : items.length ? (
        <section className={s.section}>
          {items.map((j) => <JobCard key={j.id} job={j} />)}
          {cursor && <button className={`btn ${s.bigBtn}`} disabled={loading} onClick={() => void load(cursor)}>{loading ? t('state.loading') : t('driver.loadMore')}</button>}
        </section>
      ) : !error && <div className="card"><EmptyState title={t('driver.history.empty')} /></div>}
    </>
  );
}
