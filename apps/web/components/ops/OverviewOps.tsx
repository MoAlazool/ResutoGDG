'use client';
// Overview pieces restored from legacy manager-platform.js (VS-15): the live floor with its legend (table service), the
// launch card (counter / online-only), and the "Operational insights" aside: ask box, station load and low stock.
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import type { AssistantReply, KitchenFeed, ServiceMode } from '@resuto/contracts';
import { Notice } from '@resuto/ui';
import { FloorMapPanel, useLiveFloor } from '@/components/floor/LiveFloor';
import { VenueQrCard } from '@/components/ops/ServiceMode';
import { newIdempotencyKey } from '@/lib/api';
import { formatNumber } from '@resuto/contracts';
import { useT } from '@/lib/i18n/client';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { stationLabel, unitLabel } from '@/lib/vocab';

/** Read-only live floor for the overview; selecting a table opens it on the floor page. */
export function OverviewFloor({ orgId, branchId, canEdit }: { orgId: string; branchId: string; canEdit: boolean }) {
  const { t } = useT();
  const router = useRouter();
  const data = useLiveFloor(orgId, branchId, 10_000);
  return (
    <FloorMapPanel data={data} title={t('ops.overview.liveFloor')}
      actions={<span className="fine"><span className="ws-live-dot" aria-hidden="true" /> {t('ops.overview.liveUpdates')}</span>}
      onSelect={() => router.push(`/dashboard/${orgId}/floor?branch=${branchId}`)}
      note={canEdit ? <Link href={`/dashboard/${orgId}/floor?tab=studio&branch=${branchId}`}>{t('ops.floor.editLayout')} ↗</Link> : undefined} />
  );
}

/** Counter and online-only venues get a launch card instead of a floor (legacy overview, app.js:134). */
export function LaunchCard({ orgId, branchId, mode, slug }: { orgId: string; branchId: string; mode: ServiceMode; slug: string }) {
  const { t } = useT();
  if (mode === 'counter') return <VenueQrCard orgId={orgId} branchId={branchId} title={t('ops.mode.launchTitle')} />;
  return (
    <section className="panel">
      <div className="panel-head"><h2>{t('ops.mode.onlineLaunch')}</h2></div>
      <div className="panel-body">
        <p>{t('ops.mode.onlineLaunchBody')}</p>
        <a className="btn btn-primary" href={`/order/${slug}`} target="_blank" rel="noopener noreferrer">{t('ops.mode.openSite')} ↗</a>
      </div>
    </section>
  );
}

interface LowStockItem { id: string; name: string; nameAr: string | null; unit: string; quantity: number; reorderLevel: number }

/** "Operational insights": ask the AI manager, kitchen station load and low stock, in one aside. */
export function OperationalInsights({ orgId, branchId, canAsk, canKitchen, lowStock, inventoryHref }: {
  orgId: string; branchId: string | null; canAsk: boolean; canKitchen: boolean; lowStock: LowStockItem[] | null; inventoryHref: string | null;
}) {
  const { t, locale } = useT();
  const { call } = useSession();
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AssistantReply | null>(null);
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const feed = useApi<KitchenFeed>(canKitchen && branchId ? `/o/${orgId}/kitchen/${branchId}` : null, { pollMs: 15_000 });
  const load = new Map<string, number>();
  for (const s of feed.data?.stations ?? []) load.set(s, 0);
  for (const tk of feed.data?.tickets ?? []) for (const l of tk.lines) {
    if (l.kitchenStatus === 'queued' || l.kitchenStatus === 'preparing') load.set(l.station, (load.get(l.station) ?? 0) + l.quantity);
  }
  const nf = (n: number) => formatNumber(n, locale);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const message = question.trim();
    if (!message || asking) return;
    setAsking(true); setError(null);
    try {
      setAnswer(await call<AssistantReply>(`/o/${orgId}/intelligence/assistant`, { body: { message, locale, ...(branchId ? { branchId } : {}) }, idempotencyKey: newIdempotencyKey() }));
    } catch (err) { setError((err as Error).message); } finally { setAsking(false); }
  };

  return (
    <aside className="panel ops-insights">
      <div className="panel-head"><div><h2>✧ {t('ops.overview.insights')}</h2><p>{t('ops.overview.insightsNote')}</p></div></div>
      <div className="panel-body">
        {canAsk && (
          <form className="ops-ask" onSubmit={ask}>
            <label className="sr-only" htmlFor="ops-ask">{t('ops.overview.askLabel')}</label>
            <input id="ops-ask" className="input" maxLength={1000} value={question} placeholder={t('ops.overview.askPlaceholder')} onChange={(e) => setQuestion(e.target.value)} />
            <button className="btn" disabled={asking || !question.trim()}>{asking ? t('state.loading') : t('ops.overview.ask')}</button>
            {error && <Notice tone="danger">{error}</Notice>}
            {answer && (
              <div className="ops-answer" aria-live="polite">
                <p><bdi>{answer.answer}</bdi></p>
                <small>{answer.grounded ? t('ops.overview.grounded') : t('ops.overview.notGrounded')}</small>
              </div>
            )}
            <small className="fine">{t('ops.overview.noClaims')}</small>
          </form>
        )}
        {canKitchen && (
          <div className="ops-stations">
            <h3>{t('ops.overview.stationLoad')}</h3>
            {feed.data ? (load.size ? [...load.entries()].map(([s, n]) => (
              <div key={s} className="ops-station"><span>{stationLabel(t, s)}</span><b className="num">{nf(n)}</b></div>
            )) : <p className="fine">{t('ops.overview.noStations')}</p>) : <div className="skeleton" style={{ height: 80 }} aria-hidden="true" />}
          </div>
        )}
        {lowStock && (
          <div className="ops-stations">
            <h3>{t('ops.overview.lowStock')}</h3>
            {lowStock.length ? lowStock.slice(0, 6).map((i) => (
              <div key={i.id} className="ops-station"><span>{locale === 'ar' && i.nameAr ? i.nameAr : i.name}</span>
                <b className="num">{nf(i.quantity)} {unitLabel(t, i.unit)}</b></div>
            )) : <p className="fine">✓ {t('insights.overview.stockOk')}</p>}
            {inventoryHref && lowStock.length > 0 && <Link className="fine" href={inventoryHref}>{t('insights.overview.viewAll')} →</Link>}
          </div>
        )}
      </div>
    </aside>
  );
}
