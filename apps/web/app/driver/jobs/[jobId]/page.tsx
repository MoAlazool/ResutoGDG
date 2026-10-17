'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { DELIVERY_FAILURE_REASONS, parseMajor, type Currency, type DeliveryJobView } from '@resuto/contracts';
import { Badge, Field, Notice, SelectField, Skeleton, TextareaField, useAction } from '@resuto/ui';
import { newIdempotencyKey } from '@/lib/api';
import { dateTime, money, time } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { LocationPill, useDriver } from '../../_lib/driver-context';
import { STATUS_TONE, addressLine, km } from '../../_lib/job-card';
import s from '../../driver.module.css';

interface JobDetail extends DeliveryJobView {
  proofNote: string | null;
  proofMediaId: string | null;
  proofPhotoUrl: string | null;
  events: Array<{ id: number; fromStatus: string | null; toStatus: string; actorType: string; createdAt: string; details: Record<string, unknown> }>;
  items: Array<{ name: string; nameAr: string | null; quantity: number; notes: string | null }>;
}

const minorToMajor = (minor: number) => (minor / 100).toFixed(2);

export default function DriverJobPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { t, locale } = useT();
  const router = useRouter();
  const { base, call, refresh, location } = useDriver();
  const job = useApi<JobDetail>(`${base}/jobs/${jobId}`, { pollMs: 15_000 });
  const act = useAction(async (path: string, body: object = {}, key?: string) => {
    const coords = location.lastFix ? { latitude: location.lastFix.latitude, longitude: location.lastFix.longitude } : {};
    const res = await call(`${base}/jobs/${jobId}/${path}`, { body: { ...coords, ...body }, idempotencyKey: key });
    await Promise.all([job.reload(), refresh()]);
    return res;
  });
  const [mode, setMode] = useState<'none' | 'deliver' | 'fail'>('none');

  if (job.loading && !job.data) return <Skeleton lines={8} />;
  if (job.error) {
    return (
      <div className="stack">
        <Notice tone="danger">{job.error.status === 404 ? t('driver.jobGone') : job.error.message}</Notice>
        <Link className={s.linkBtn} href="/driver">← {t('driver.back')}</Link>
      </div>
    );
  }
  const j = job.data!;
  const phone = j.dropoff.customerPhone;
  const closed = ['delivered', 'failed', 'cancelled', 'unassigned'].includes(j.status);

  return (
    <>
      <div className="spread">
        <Link className="btn btn-sm btn-ghost" href="/driver">← {t('driver.back')}</Link>
        <Badge tone={STATUS_TONE[j.status]}>{t(`driver.status.${j.status}`)}</Badge>
      </div>
      <h1 style={{ fontSize: 24, margin: 0 }}>{t('driver.order', { n: j.orderNumber })}</h1>
      {(j.status === 'picked_up' || j.status === 'en_route') && <LocationPill />}

      <section className={s.detailBlock} aria-label={t('driver.customer')}>
        <span className={s.label}>{t('driver.customer')}</span>
        <span className={s.value}>{j.dropoff.customerName ?? '—'}</span>
        {phone && <a className={s.linkBtn} href={`tel:${phone}`}>📞 {t('driver.call')} <span dir="ltr">{phone}</span></a>}
      </section>

      <section className={s.detailBlock} aria-label={t('driver.address')}>
        <span className={s.label}>{t('driver.address')}</span>
        <span className={s.value}>{addressLine(j) || '—'}</span>
        {j.dropoff.notes && <span>📝 {j.dropoff.notes}</span>}
        <div className={s.meta}>
          {j.distanceM !== null && <span>{t('driver.distance', { km: km(j.distanceM)! })}</span>}
          {j.etaAt && <span>{t('driver.eta', { t: time(j.etaAt, locale) })}</span>}
        </div>
        {j.navigationUrl && <a className={`btn btn-leaf ${s.bigBtn}`} href={j.navigationUrl} target="_blank" rel="noopener noreferrer">🗺 {t('driver.openMaps')}</a>}
        {j.pickup.address && <span className="fine">{t('driver.pickupFrom', { place: j.branchName ?? '', address: j.pickup.address })}</span>}
      </section>

      <section className={s.detailBlock}>
        <div className="spread">
          <span className={s.label}>{t('driver.payment')}</span>
          {j.codAmountMinor > 0 && j.cashStatus !== 'none'
            ? <span className={s.cod} style={{ fontSize: 20 }}>{money(j.cashStatus === 'pending' ? j.codAmountMinor : j.cashCollectedMinor, j.currency, locale)}</span>
            : <Badge tone="ok">{t('driver.prepaid')}</Badge>}
        </div>
        {j.cashStatus === 'pending' && <span>{t('driver.codHint')}</span>}
        {j.cashStatus === 'collected' && <span>{t('driver.cash.collectedOnJob')}</span>}
      </section>

      <section className={s.detailBlock}>
        <span className={s.label}>{t('driver.items')}</span>
        <ul className={s.items}>
          {j.items.map((i, idx) => <li key={idx}>{i.quantity} × {locale === 'ar' && i.nameAr ? i.nameAr : i.name}{i.notes ? ` — ${i.notes}` : ''}</li>)}
        </ul>
        <span className="fine">{t('driver.orderStatus', { s: t(`driver.orderState.${j.orderStatus}`) })}</span>
      </section>

      {act.error && <Notice tone="danger">{act.error}</Notice>}

      {mode === 'deliver' && <DeliverForm job={j} onDone={() => { setMode('none'); router.push('/driver'); }} run={act.run} pending={act.pending} />}
      {mode === 'fail' && <FailForm onCancel={() => setMode('none')} run={async (body) => { const r = await act.run('fail', body); if (r) setMode('none'); }} pending={act.pending} />}

      {!closed && mode === 'none' && (
        <div className={s.actions}>
          {j.status === 'assigned' && (
            <div className={s.row2}>
              <button className={`btn btn-primary ${s.bigBtn}`} disabled={act.pending} onClick={() => void act.run('accept')}>{t('driver.accept')}</button>
              <button className={`btn ${s.bigBtn}`} disabled={act.pending} onClick={() => void act.run('decline').then((r) => { if (r) router.push('/driver'); })}>{t('driver.decline')}</button>
            </div>
          )}
          {j.status === 'offered' && (
            <div className={s.row2}>
              <button className={`btn btn-primary ${s.bigBtn}`} disabled={act.pending} onClick={() => void act.run('accept')}>{t('driver.accept')}</button>
              <button className={`btn ${s.bigBtn}`} disabled={act.pending} onClick={() => void act.run('decline').then((r) => { if (r) router.push('/driver'); })}>{t('driver.decline')}</button>
            </div>
          )}
          {j.status === 'accepted' && (
            <>
              {j.orderStatus !== 'ready' && <Notice tone="warn">{t('driver.notReady')}</Notice>}
              <button className={`btn btn-primary ${s.bigBtn}`} disabled={act.pending || j.orderStatus !== 'ready'} onClick={() => void act.run('pickup')}>{t('driver.action.pickup')}</button>
            </>
          )}
          {j.status === 'picked_up' && (
            <button className={`btn btn-primary ${s.bigBtn}`} disabled={act.pending} onClick={() => void act.run('en-route')}>{t('driver.action.enRoute')}</button>
          )}
          {(j.status === 'picked_up' || j.status === 'en_route') && (
            <div className={s.row2}>
              <button className={`btn btn-ember ${s.bigBtn}`} onClick={() => setMode('deliver')}>{t('driver.action.deliver')}</button>
              <button className={`btn btn-danger ${s.bigBtn}`} onClick={() => setMode('fail')}>{t('driver.action.fail')}</button>
            </div>
          )}
        </div>
      )}

      {j.status === 'delivered' && <Notice tone="ok">{t('driver.deliveredAt', { t: dateTime(j.deliveredAt, locale) })}</Notice>}
      {j.status === 'failed' && <Notice tone="warn">{t('driver.failedNotice', { reason: t(`driver.fail.reasons.${j.failureReason ?? 'other'}`) })}</Notice>}

      <section className={s.detailBlock}>
        <span className={s.label}>{t('driver.timeline')}</span>
        <ol className={s.timeline}>
          {j.events.map((e) => <li key={e.id}><span>{t(`driver.status.${e.toStatus}`)}</span><span className="muted">{time(e.createdAt, locale)}</span></li>)}
        </ol>
      </section>
    </>
  );
}

function DeliverForm({ job, run, pending, onDone }: {
  job: JobDetail; pending: boolean; onDone(): void;
  run: (path: string, body?: object, key?: string) => Promise<unknown>;
}) {
  const { t, locale } = useT();
  const { base, call } = useDriver();
  const [photo, setPhoto] = useState<{ mediaId: string; preview: string } | null>(job.proofPhotoUrl && job.proofMediaId ? { mediaId: job.proofMediaId, preview: job.proofPhotoUrl } : null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const key = useRef(newIdempotencyKey());
  const fileRef = useRef<HTMLInputElement>(null);
  const due = job.cashStatus === 'pending' ? job.codAmountMinor : 0;
  useEffect(() => () => { if (photo?.preview.startsWith('blob:')) URL.revokeObjectURL(photo.preview); }, [photo]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await call<{ mediaId: string }>(`${base}/jobs/${job.id}/proof-photo`, { body: form });
      setPhoto({ mediaId: res.mediaId, preview: URL.createObjectURL(file) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const recipientName = String(f.get('recipientName') || '').trim() || null;
    const otp = String(f.get('otp') || '').trim() || null;
    const mediaId = photo?.mediaId || null;
    if (!recipientName && !otp && !mediaId) { setError(t('driver.proof.needOne')); return; }
    let cashCollectedMinor: number | undefined;
    if (due > 0) {
      try { cashCollectedMinor = parseMajor(String(f.get('cash') || '0'), job.currency as Currency); } catch { setError(t('driver.proof.cashInvalid')); return; }
    }
    setError(null);
    const res = await run('deliver', { recipientName, otp, proofMediaId: mediaId || undefined, cashCollectedMinor, note: String(f.get('note') || '').trim() || null }, key.current);
    if (res) onDone();
  }

  return (
    <form className={s.detailBlock} onSubmit={submit}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{t('driver.proof.title')}</h2>
      <div className={s.photoInput}>
        <input ref={fileRef} id="proof-photo" type="file" accept="image/*" capture="environment" onChange={(e) => void onFile(e.target.files?.[0])} />
        {photo && <img className={s.photoPreview} src={photo.preview} alt={t('driver.proof.uploaded')} />}
        <button type="button" className={`btn ${s.bigBtn}`} disabled={uploading} onClick={() => fileRef.current?.click()}>
          📷 {uploading ? t('state.loading') : photo ? t('driver.proof.retake') : t('driver.proof.photo')}
        </button>
      </div>
      <Field label={t('driver.proof.recipient')} name="recipientName" autoComplete="off" maxLength={120} />
      {job.hasOtp && <Field label={t('driver.proof.otp')} name="otp" inputMode="numeric" pattern="\d{4}" maxLength={4} autoComplete="one-time-code" dir="ltr" />}
      {due > 0 && (
        <Field label={t('driver.proof.cash')} name="cash" inputMode="decimal" defaultValue={minorToMajor(due)} required dir="ltr"
          hint={t('driver.proof.cashHint', { amount: money(due, job.currency, locale) })} />
      )}
      <TextareaField label={t('driver.fail.note')} name="note" maxLength={300} rows={2} />
      {error && <Notice tone="danger">{error}</Notice>}
      <button className={`btn btn-ember ${s.bigBtn}`} disabled={pending || uploading}>{pending ? t('state.loading') : t('driver.action.confirmDelivered')}</button>
      <button type="button" className={`btn btn-ghost ${s.bigBtn}`} onClick={onDone}>{t('action.cancel')}</button>
    </form>
  );
}

function FailForm({ run, pending, onCancel }: { run(body: object): Promise<void>; pending: boolean; onCancel(): void }) {
  const { t } = useT();
  return (
    <form className={s.detailBlock} onSubmit={(e) => {
      e.preventDefault();
      const f = new FormData(e.currentTarget);
      void run({ reason: f.get('reason'), note: String(f.get('note') || '').trim() || null });
    }}>
      <h2 style={{ margin: 0, fontSize: 18 }}>{t('driver.action.fail')}</h2>
      <SelectField label={t('driver.fail.reason')} name="reason" defaultValue="customer_unreachable">
        {DELIVERY_FAILURE_REASONS.filter((r) => r !== 'order_cancelled').map((r) => <option key={r} value={r}>{t(`driver.fail.reasons.${r}`)}</option>)}
      </SelectField>
      <TextareaField label={t('driver.fail.note')} name="note" maxLength={300} rows={2} />
      <button className={`btn btn-danger ${s.bigBtn}`} disabled={pending}>{t('driver.fail.confirm')}</button>
      <button type="button" className={`btn btn-ghost ${s.bigBtn}`} onClick={onCancel}>{t('action.cancel')}</button>
    </form>
  );
}
