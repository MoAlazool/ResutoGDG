'use client';
import { formatDate, formatNumber, type LoyaltyBalance, type LoyaltyLedgerEntry } from '@resuto/contracts';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { Field, Modal, Notice, SkeletonBlock, Stat, useAction } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { LedgerTable } from './LedgerTable';

/**
 * Loyalty block on the customer profile (FT-03): balance derived from the ledger, points expiring soon, recent
 * movements, and an audited manual adjustment for people with marketing:approve. Hidden without the Marketing module.
 */
export function CustomerLoyalty({ customerId }: { customerId: string }) {
  const { t, locale } = useT();
  const { org, can, hasModule } = useOrg();
  const { call } = useSession();
  const enabled = hasModule('marketing');
  const bal = useApi<LoyaltyBalance>(enabled ? `/o/${org.id}/loyalty/customers/${customerId}` : null);
  const led = useApi<{ items: LoyaltyLedgerEntry[] }>(enabled ? `/o/${org.id}/loyalty/ledger?customerId=${customerId}&limit=10` : null);
  const [adj, setAdj] = useState<{ points: string; reason: string; key: string } | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const save = useAction(async (e: FormEvent) => {
    e.preventDefault();
    const r = await call<{ balance: number }>(`/o/${org.id}/loyalty/adjustments`, {
      method: 'POST', headers: { 'Idempotency-Key': adj!.key }, body: { customerId, points: Math.trunc(Number(adj!.points)), reason: adj!.reason.trim() },
    });
    setAdj(null);
    setDone(r.balance);
    await Promise.all([bal.reload(), led.reload()]);
  });
  if (!enabled) return null;
  return (
    <section className="card mbe-16">
      <div className="spread" style={{ alignItems: 'center', marginBlockEnd: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{t('loyalty.customer.title')}</h2>
        <div className="row gap-8">
          {can('orders:write') && <Link className="btn btn-sm btn-primary" href={`/dashboard/${org.id}/orders?newFor=${customerId}`}>{t('loyalty.customer.redeem')}</Link>}
          {can('marketing:approve') && <button type="button" className="btn btn-sm" onClick={() => setAdj({ points: '', reason: '', key: crypto.randomUUID() })}>{t('loyalty.customer.adjust')}</button>}
          <Link className="btn btn-sm btn-ghost" href={`/dashboard/${org.id}/loyalty`}>{t('loyalty.customer.manage')}</Link>
        </div>
      </div>
      {done !== null && <Notice tone="ok">{t('loyalty.customer.adjusted', { balance: formatNumber(done, locale) })}</Notice>}
      {!bal.data ? <SkeletonBlock height={64} /> : (
        <div className="grid grid-3 mbe-12">
          <Stat label={t('loyalty.customer.balance')} value={formatNumber(bal.data.balance, locale)} />
          <Stat label={t('loyalty.customer.lifetime')} value={formatNumber(bal.data.lifetimeEarned, locale)} />
          {bal.data.expiringSoon && <Stat label={t('loyalty.customer.expiringLabel')} value={t('loyalty.customer.expiring', {
            points: formatNumber(bal.data.expiringSoon.points, locale), date: formatDate(bal.data.expiringSoon.at, locale, org.timezone) })} />}
        </div>
      )}
      <h3 className="fine" style={{ marginBlock: '6px' }}>{t('loyalty.customer.recent')}</h3>
      <LedgerTable rows={led.data?.items ?? []} pending={led.loading} showGuest={false} />
      <Modal open={!!adj} onClose={() => setAdj(null)} title={t('loyalty.customer.adjust')}>
        {adj && (
          <form onSubmit={save.run}>
            <Field label={t('loyalty.customer.adjustPoints')} required inputMode="numeric" dir="ltr" value={adj.points} onChange={(e) => setAdj({ ...adj, points: e.target.value })} />
            <Field label={t('loyalty.customer.reason')} required minLength={3} maxLength={300} value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} />
            {save.error && <Notice tone="danger">{save.error}</Notice>}
            <div className="row justify-end">
              <button className="btn btn-primary" disabled={save.pending || !Number(adj.points) || adj.reason.trim().length < 3}>{t('action.save')}</button>
            </div>
          </form>
        )}
      </Modal>
    </section>
  );
}
