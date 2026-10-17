'use client';
import { useEffect, useMemo, useState } from 'react';
import { parseMajor, type Currency, type DeliveryJobView, type DriverView } from '@resuto/contracts';
import { Card, DataTable, EmptyState, Field, Notice, Skeleton, useAction } from '@resuto/ui';
import { newIdempotencyKey } from '@/lib/api';
import { dateTime, money } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';

interface DriverProfile extends DriverView { unsettledJobs: DeliveryJobView[] }
interface Settlement { id: string; driverName: string; amountMinor: number; currency: string; jobIds: string[]; note: string | null; createdAt: string }

/** COD cash handover: pick a driver, tick the deliveries whose cash is handed over, record the exact amount. */
export function Cash() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const drivers = useApi<{ items: DriverView[] }>(`/o/${org.id}/delivery/drivers`);
  const settlements = useApi<{ items: Settlement[] }>(`/o/${org.id}/delivery/settlements`);
  const holding = (drivers.data?.items ?? []).filter((d) => d.cashOnHandMinor > 0);
  const [driverId, setDriverId] = useState<string | null>(null);
  const profile = useApi<DriverProfile>(driverId ? `/o/${org.id}/delivery/drivers/${driverId}` : null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(newIdempotencyKey);
  const act = useAction(async (body: object) => {
    const r = await call(`/o/${org.id}/delivery/settlements`, { body, idempotencyKey: key });
    setKey(newIdempotencyKey());
    await Promise.all([drivers.reload(), settlements.reload(), profile.reload()]);
    setSelected(new Set());
    setNote('');
    return r;
  });

  const jobs = profile.data?.unsettledJobs ?? [];
  const sum = useMemo(() => jobs.filter((j) => selected.has(j.id)).reduce((s, j) => s + j.cashCollectedMinor, 0), [jobs, selected]);
  useEffect(() => { setSelected(new Set(jobs.map((j) => j.id))); }, [profile.data]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setAmount((sum / 100).toFixed(2)); }, [sum]);

  const submit = () => {
    let amountMinor: number;
    try { amountMinor = parseMajor(amount, org.currency as Currency); } catch { act.setError(t('driver.proof.cashInvalid')); return; }
    void act.run({ driverId, jobIds: [...selected], amountMinor, note: note.trim() || null });
  };

  return (
    <div className="stack">
      <Card title={t('driver.dispatch.cashHolding')}>
        {drivers.loading && !drivers.data ? <Skeleton lines={3} /> : holding.length ? (
          <div className="row">
            {holding.map((d) => (
              <button key={d.id} className={`btn ${driverId === d.id ? 'btn-primary' : ''}`} onClick={() => setDriverId(d.id)}>
                {d.displayName} · {money(d.cashOnHandMinor, org.currency, locale)}
              </button>
            ))}
          </div>
        ) : <EmptyState title={t('driver.dispatch.noCash')} />}
      </Card>
      {driverId && (
        <Card title={t('driver.dispatch.settleFor', { name: profile.data?.displayName ?? '' })}>
          {profile.loading && !profile.data ? <Skeleton lines={4} /> : (
            <div className="stack">
              {jobs.map((j) => (
                <label key={j.id} className="check" style={{ justifyContent: 'space-between', display: 'flex' }}>
                  <span><input type="checkbox" checked={selected.has(j.id)} onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(j.id); else next.delete(j.id);
                    setSelected(next);
                  }} /> {t('driver.order', { n: j.orderNumber })} · <span className="muted">{dateTime(j.deliveredAt, locale)}</span></span>
                  <strong>{money(j.cashCollectedMinor, j.currency, locale)}</strong>
                </label>
              ))}
              <div className="form-row">
                <Field label={t('driver.dispatch.settleAmount')} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" dir="ltr"
                  hint={t('driver.dispatch.settleHint', { amount: money(sum, org.currency, locale) })} />
                <Field label={t('driver.fail.note')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
              </div>
              {act.error && <Notice tone="danger">{act.error}</Notice>}
              <div><button className="btn btn-primary" disabled={!selected.size || act.pending} onClick={submit}>{t('driver.dispatch.settle')}</button></div>
            </div>
          )}
        </Card>
      )}
      <Card title={t('driver.cash.settlements')}>
        {settlements.loading && !settlements.data ? <Skeleton lines={3} /> : (
          <DataTable rows={settlements.data?.items ?? []} rowKey={(x) => x.id} empty={<EmptyState title={t('driver.cash.noSettlements')} />}
            columns={[
              { key: 'when', header: t('driver.dispatch.when'), render: (x) => dateTime(x.createdAt, locale) },
              { key: 'driver', header: t('driver.dispatch.driver'), render: (x) => x.driverName },
              { key: 'jobs', header: t('driver.dispatch.deliveries'), align: 'end', render: (x) => x.jobIds.length },
              { key: 'amount', header: t('driver.dispatch.settleAmount'), align: 'end', render: (x) => money(x.amountMinor, x.currency, locale) },
              { key: 'note', header: t('driver.fail.note'), render: (x) => x.note ?? '' },
            ]} />
        )}
      </Card>
    </div>
  );
}
