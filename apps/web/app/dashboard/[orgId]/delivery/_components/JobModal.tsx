'use client';
import { useState } from 'react';
import type { DeliveryJobView } from '@resuto/contracts';
import { Badge, Field, Modal, Notice, Skeleton, useAction } from '@resuto/ui';
import { dateTime, money, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import { JobStatus, addressOf } from './shared';

interface JobDetail extends DeliveryJobView {
  proofNote: string | null;
  proofPhotoUrl: string | null;
  events: Array<{ id: number; fromStatus: string | null; toStatus: string; actorType: string; actorId: string | null; latitude: number | null; longitude: number | null; details: Record<string, any>; createdAt: string }>;
  offers: Array<{ id: string; driverName: string; status: string; expiresAt: string; respondedAt: string | null }>;
  items: Array<{ name: string; nameAr: string | null; quantity: number; notes: string | null }>;
}

/** Job detail with timeline, proof and dispatcher actions (delivery code, cancel). */
export function JobModal({ jobId, onClose, onChanged }: { jobId: string; onClose(): void; onChanged(): void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const job = useApi<JobDetail>(`/o/${org.id}/delivery/jobs/${jobId}`, { pollMs: 15_000 });
  const [otp, setOtp] = useState<{ code: string; messaging: { status: string; reason?: string } } | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const act = useAction(async (fn: () => Promise<unknown>) => { const r = await fn(); await job.reload(); onChanged(); return r; });
  const j = job.data;
  const closed = j && ['delivered', 'cancelled'].includes(j.status);

  return (
    <Modal open onClose={onClose} title={j ? t('driver.dispatch.jobTitle', { n: j.orderNumber }) : t('state.loading')}>
      {!j ? (job.error ? <Notice tone="danger">{job.error.message}</Notice> : <Skeleton lines={6} />) : (
        <div className="stack">
          <div className="spread"><JobStatus status={j.status} /><span className="muted">{j.branchName}</span></div>
          <div className="grid grid-2" style={{ gap: 10 }}>
            <div><div className="fine">{t('driver.customer')}</div><strong><bdi>{j.dropoff.customerName ?? '—'}</bdi></strong>{j.dropoff.customerPhone && <div dir="ltr" style={{ textAlign: 'start' }}>{j.dropoff.customerPhone}</div>}</div>
            <div><div className="fine">{t('driver.address')}</div><strong><bdi>{addressOf(j) || '—'}</bdi></strong>{j.dropoff.notes && <div className="fine"><bdi>{j.dropoff.notes}</bdi></div>}</div>
            <div><div className="fine">{t('driver.dispatch.driver')}</div><strong>{j.driverName ?? '—'}</strong></div>
            <div><div className="fine">{t('driver.payment')}</div><strong>{j.codAmountMinor > 0 && j.cashStatus !== 'none' ? `${money(j.codAmountMinor, j.currency, locale)} · ${t(`driver.dispatch.cash.${j.cashStatus}`)}` : t('driver.prepaid')}</strong></div>
          </div>
          {j.etaAt && <p className="fine" style={{ margin: 0 }}>{t('driver.eta', { t: time(j.etaAt, locale) })} — {t('driver.dispatch.etaNote')}</p>}
          {j.navigationUrl && <a className="btn btn-sm btn-leaf" href={j.navigationUrl} target="_blank" rel="noopener noreferrer">🗺 {t('driver.openMaps')}</a>}
          <div>
            <div className="fine">{t('driver.items')}</div>
            <ul style={{ margin: '4px 0 0', paddingInlineStart: 18 }}>{j.items.map((i, k) => <li key={k}>{i.quantity} × {locale === 'ar' && i.nameAr ? i.nameAr : i.name}</li>)}</ul>
          </div>
          {(j.proofPhotoUrl || j.proofRecipient) && (
            <div className="card card-warm" style={{ padding: 14 }}>
              <strong>{t('driver.proof.title')}</strong>
              {j.proofRecipient && <div>{t('driver.proof.recipient')}: <bdi>{j.proofRecipient}</bdi></div>}
              {j.proofNote && <div className="fine"><bdi>{j.proofNote}</bdi></div>}
              {j.proofPhotoUrl && <img src={j.proofPhotoUrl} alt={t('driver.proof.title')} style={{ marginBlockStart: 8, maxHeight: 220, borderRadius: 10 }} />}
            </div>
          )}
          <div>
            <div className="fine">{t('driver.timeline')}</div>
            <ol style={{ margin: '4px 0 0', paddingInlineStart: 18, display: 'grid', gap: 4 }}>
              {j.events.map((e) => (
                <li key={e.id}>
                  <strong>{t(`driver.status.${e.toStatus}`)}</strong> · <span className="muted">{dateTime(e.createdAt, locale)}</span> · {t(`driver.dispatch.actor.${e.actorType}`)}
                  {e.details?.reason ? <span className="fine"> · {String(e.details.reason)}</span> : null}
                  {e.latitude !== null && e.longitude !== null && <span className="fine" dir="ltr"> · {e.latitude.toFixed(4)}, {e.longitude.toFixed(4)}</span>}
                </li>
              ))}
            </ol>
          </div>
          {!!j.offers.length && (
            <div className="fine">{t('driver.dispatch.offers')}: {j.offers.map((o) => `${o.driverName} (${t(`driver.dispatch.offerStatus.${o.status}`)})`).join(', ')}</div>
          )}
          {act.error && <Notice tone="danger">{act.error}</Notice>}
          {otp && (
            <Notice tone="ok">
              {t('driver.dispatch.otpShown', { code: otp.code })} · {t(`driver.dispatch.otpMessaging.${otp.messaging.status}`)}
            </Notice>
          )}
          {!closed && (
            <div className="row">
              {!['failed'].includes(j.status) && (
                <button className="btn btn-sm" disabled={act.pending} onClick={() => void act.run(async () => setOtp(await call(`/o/${org.id}/delivery/jobs/${j.id}/otp`, { body: {} })))}>
                  🔑 {j.hasOtp ? t('driver.dispatch.regenerateOtp') : t('driver.dispatch.generateOtp')}
                </button>
              )}
              {j.hasOtp && !otp && <Badge tone="info">{t('driver.dispatch.otpActive')}</Badge>}
              {!cancelling && <button className="btn btn-sm btn-danger" onClick={() => setCancelling(true)}>{t('driver.dispatch.cancel')}</button>}
            </div>
          )}
          {cancelling && !closed && (
            <form className="stack" onSubmit={(e) => {
              e.preventDefault();
              const reason = String(new FormData(e.currentTarget).get('reason') || '').trim();
              void act.run(() => call(`/o/${org.id}/delivery/jobs/${j.id}/cancel`, { body: { reason } })).then(() => setCancelling(false));
            }}>
              <Field label={t('driver.dispatch.cancelReason')} name="reason" required maxLength={300} />
              <Notice tone="warn">{t('driver.dispatch.cancelNote')}</Notice>
              <div className="row"><button className="btn btn-sm btn-danger" disabled={act.pending}>{t('action.confirm')}</button><button type="button" className="btn btn-sm btn-ghost" onClick={() => setCancelling(false)}>{t('action.back')}</button></div>
            </form>
          )}
        </div>
      )}
    </Modal>
  );
}
