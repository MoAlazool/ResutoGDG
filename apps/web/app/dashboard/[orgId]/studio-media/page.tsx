'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { PHOTO_ASPECTS, type PhotoJobView, type StudioAiCapabilities } from '@resuto/contracts';
import { Badge, EmptyState, Notice, PageHeader, SkeletonCards, ToastProvider, useToast } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { newIdempotencyKey } from '@/lib/api';
import { dateTime, num } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import './studio-media.css';

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'pay' | 'neutral';
const TONE: Record<PhotoJobView['status'], Tone> = { queued: 'info', processing: 'info', review: 'pay', approved: 'ok', rejected: 'neutral', published: 'ok', failed: 'danger' };
interface Product { id: string; name: string; nameAr: string | null; category: string }
interface Section { id: string; kind: string }

export default function StudioMediaPage() {
  const { t } = useT();
  return (
    <ModuleGate module="studio" permission="studio:read">
      <ToastProvider closeLabel={t('action.close')}><FoodPhotos /></ToastProvider>
    </ModuleGate>
  );
}

function FoodPhotos() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const [poll, setPoll] = useState<number | undefined>();
  const jobs = useApi<{ items: PhotoJobView[] }>(`/o/${org.id}/studio/photos`, { pollMs: poll });
  const caps = useApi<StudioAiCapabilities>(`/o/${org.id}/studio-ai/capabilities`);
  const [selected, setSelected] = useState<string | null>(null);
  const busy = jobs.data?.items.some((j) => j.status === 'queued' || j.status === 'processing');
  useEffect(() => { setPoll(busy ? 3000 : undefined); }, [busy]);
  const current = jobs.data?.items.find((j) => j.id === selected) ?? null;
  const canWrite = can('studio:write');
  const reviewRef = useRef<HTMLDivElement>(null);
  // Single-column layouts put the review below the queue: bring it into view when a photo is picked.
  useEffect(() => {
    if (selected && typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches) reviewRef.current?.scrollIntoView({ block: 'start' });
  }, [selected]);

  return (
    <>
      <PageHeader overline={t('nav.website')} title={t('studio.ai.photo.title')} subtitle={t('studio.ai.photo.subtitle')}
        actions={<Link className="btn" href={`/dashboard/${org.id}/website`}>{t('studio.ai.photo.toWebsite')}</Link>} />
      <div className="sm-modes">
        <Notice tone="ok"><strong>{t('studio.ai.photo.modeDeterministic')}</strong> {t('studio.ai.photo.modeDeterministicBody')}</Notice>
        <Notice tone="info"><span className="row" style={{ gap: 8 }}><Badge tone="neutral">{t('studio.ai.photo.notConfigured')}</Badge><strong>{t('studio.ai.photo.modeGenerative')}</strong></span>
          <span>{t('studio.ai.photo.modeGenerativeBody')}</span></Notice>
      </div>
      {caps.data && !caps.data.photoEnhancement.deterministic && <Notice tone="danger">{t('studio.ai.photo.unavailable')}</Notice>}
      <div className="sm-layout">
        <div className="stack">
          {canWrite && <UploadCard onCreated={async (j) => { await jobs.reload(); setSelected(j.id); }} />}
          <section className="card">
            <h2 className="sm-h2">{t('studio.ai.photo.queue')}</h2>
            {!jobs.data ? <SkeletonCards count={4} height={120} /> : jobs.data.items.length === 0 ? <p className="fine">{t('studio.ai.photo.empty')}</p> : (
              <ul className="sm-grid">
                {jobs.data.items.map((j) => (
                  <li key={j.id}>
                    <button type="button" className="sm-tile" aria-current={j.id === selected ? 'true' : undefined} onClick={() => setSelected(j.id)}>
                      {(j.output?.url || j.original.url) ? <img src={j.output?.url || j.original.url} alt="" loading="lazy" /> : <span className="sm-ph" />}
                      <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <Badge tone={TONE[j.status]}>{t(`studio.ai.photo.status.${j.status}`)}</Badge>
                        <span className="fine">{dateTime(j.createdAt, locale, org.timezone)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <div className="sm-review" ref={reviewRef}>
          {current ? <ReviewCard job={current} canWrite={canWrite} onChanged={() => jobs.reload()} />
            : <div className="card"><EmptyState title={t('studio.ai.photo.pick')}>{t('studio.ai.photo.subtitle')}</EmptyState></div>}
        </div>
      </div>
    </>
  );
}

function UploadCard({ onCreated }: { onCreated: (j: PhotoJobView) => Promise<void> }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const toast = useToast();
  const products = useApi<{ items: Product[] }>(`/o/${org.id}/studio/products`);
  const [file, setFile] = useState<File | null>(null);
  const [productId, setProductId] = useState('');
  // Opened from the menu editor ("Enhance a photo of this item"): preselect that item once the list is loaded.
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('product');
    if (wanted && products.data?.items.some((x) => x.id === wanted)) setProductId((cur) => cur || wanted);
  }, [products.data]);
  const [p, setP] = useState({ aspect: '4:3' as (typeof PHOTO_ASPECTS)[number], trimBorder: true, exposure: 0, whiteBalance: true, contrast: 0.35, sharpen: 0.5 });
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      if (productId) form.append('productId', productId);
      form.append('mode', 'deterministic');
      form.append('params', JSON.stringify(p));
      const job = await call<PhotoJobView>(`/o/${org.id}/studio/photos`, { body: form });
      setFile(null);
      await onCreated(job);
    } catch (e) { toast.show({ message: (e as Error).message, tone: 'danger' }); } finally { setBusy(false); }
  };
  return (
    <section className="card stack">
      <h2 className="sm-h2">{t('studio.ai.photo.new')}</h2>
      <label className="field"><span>{t('studio.ai.photo.file')}</span>
        <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      <label className="field"><span>{t('studio.ai.photo.dish')}</span>
        <select className="select" value={productId} onChange={(e) => setProductId(e.target.value)}>
          <option value="">{t('studio.ai.photo.noDish')}</option>
          {(products.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{locale === 'ar' && x.nameAr ? x.nameAr : x.name}</option>)}
        </select></label>
      <label className="field"><span>{t('studio.ai.photo.aspect')}</span>
        <select className="select" value={p.aspect} onChange={(e) => setP({ ...p, aspect: e.target.value as typeof p.aspect })}>
          {PHOTO_ASPECTS.map((a) => <option key={a} value={a}>{a === 'original' ? t('studio.ai.photo.aspectOriginal') : a}</option>)}
        </select></label>
      <details>
        <summary className="fine" style={{ cursor: 'pointer' }}>{t('studio.ai.photo.adjust')}</summary>
        <div className="stack" style={{ marginTop: 8 }}>
          <Slider label={t('studio.ai.photo.exposure')} min={-1} max={1} value={p.exposure} onChange={(v) => setP({ ...p, exposure: v })} />
          <Slider label={t('studio.ai.photo.contrast')} min={0} max={1} value={p.contrast} onChange={(v) => setP({ ...p, contrast: v })} />
          <Slider label={t('studio.ai.photo.sharpen')} min={0} max={1} value={p.sharpen} onChange={(v) => setP({ ...p, sharpen: v })} />
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={p.whiteBalance} onChange={(e) => setP({ ...p, whiteBalance: e.target.checked })} />{t('studio.ai.photo.whiteBalance')}</label>
          <label className="row" style={{ gap: 8 }}><input type="checkbox" checked={p.trimBorder} onChange={(e) => setP({ ...p, trimBorder: e.target.checked })} />{t('studio.ai.photo.trim')}</label>
        </div>
      </details>
      <div><button type="button" className="btn btn-primary" disabled={!file || busy} aria-busy={busy} onClick={() => void send()}>{busy ? t('state.loading') : t('studio.ai.photo.enhance')}</button></div>
    </section>
  );
}

function Slider({ label, min, max, value, onChange }: { label: string; min: number; max: number; value: number; onChange: (v: number) => void }) {
  const { locale } = useT();
  return (
    <label className="field"><span className="spread">{label}<bdi className="fine">{num(value, locale, 2)}</bdi></span>
      <input type="range" min={min} max={max} step={0.05} value={value} onChange={(e) => onChange(Number(e.target.value))} /></label>
  );
}

function ReviewCard({ job, canWrite, onChanged }: { job: PhotoJobView; canWrite: boolean; onChanged: () => Promise<unknown> | void }) {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const { call } = useSession();
  const toast = useToast();
  const [split, setSplit] = useState(50);
  const [note, setNote] = useState('');
  const [target, setTarget] = useState<'product' | 'website_section'>(job.productId ? 'product' : 'website_section');
  const [targetId, setTargetId] = useState(job.productId ?? '');
  const [busy, setBusy] = useState(false);
  const products = useApi<{ items: Product[] }>(`/o/${org.id}/studio/products`);
  const site = useApi<{ sections: Section[] }>(`/o/${org.id}/studio/website`);
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); toast.show({ message: ok, tone: 'ok' }); await onChanged(); } catch (e) { toast.show({ message: (e as Error).message, tone: 'danger' }); } finally { setBusy(false); }
  };
  const ops = ((job.provenance?.operations as Array<Record<string, unknown>> | undefined) ?? []).filter((o) => o.op !== 'measure');
  const publishable = job.status === 'approved' || job.status === 'published';

  return (
    <section className="card stack" aria-busy={busy}>
      <div className="spread">
        <h2 className="sm-h2">{t('studio.ai.photo.review')}</h2>
        <span className="row" style={{ gap: 6 }}>
          <Badge tone={TONE[job.status]}>{t(`studio.ai.photo.status.${job.status}`)}</Badge>
          <Badge tone="neutral">{job.mode === 'deterministic' ? t('studio.ai.photo.labelDeterministic') : t('studio.ai.photo.labelGenerative', { model: job.model ?? job.provider })}</Badge>
        </span>
      </div>
      {(job.status === 'queued' || job.status === 'processing') && <Notice tone="info">{t('studio.ai.photo.working')}</Notice>}
      {job.status === 'failed' && <Notice tone="danger"><span>{job.error}</span>{' '}
        {canWrite && <button type="button" className="btn btn-sm" onClick={() => void act(() => call(`/o/${org.id}/studio/photos/${job.id}/retry`, { body: {} }), t('studio.ai.photo.retried'))}>{t('action.retry')}</button>}</Notice>}
      {job.output ? (
        <div className="stack" style={{ gap: 6 }}>
          <div className="sm-compare" style={{ ['--split' as string]: `${split}%` }}>
            <img src={job.original.url} alt={t('studio.ai.photo.before')} className="sm-before" />
            <img src={job.output.url} alt={t('studio.ai.photo.after')} className="sm-after" />
            <span className="sm-label sm-label-before">{t('studio.ai.photo.before')}</span>
            <span className="sm-label sm-label-after">{t('studio.ai.photo.after')}</span>
          </div>
          <label className="field"><span>{t('studio.ai.photo.compare')}</span>
            <input type="range" min={0} max={100} value={split} onChange={(e) => setSplit(Number(e.target.value))} /></label>
          <p className="fine" style={{ margin: 0 }}>
            {t('studio.ai.photo.sizes', { before: `${num(job.original.width ?? 0, locale)}×${num(job.original.height ?? 0, locale)}`, after: `${num(job.output.width ?? 0, locale)}×${num(job.output.height ?? 0, locale)}` })}
            {' · '}<bdi dir="ltr">{job.output.formats.map((f) => `${f.format.toUpperCase()} ${f.width}w`).join(' · ')}</bdi>
          </p>
        </div>
      ) : job.original.url ? <img src={job.original.url} alt={t('studio.ai.photo.before')} className="sm-single" /> : null}
      {job.provenance && (
        <details>
          <summary className="fine" style={{ cursor: 'pointer' }}>{t('studio.ai.photo.provenance')}</summary>
          <p className="fine">{t(job.mode === 'deterministic' ? 'studio.ai.photo.guarantee' : 'studio.ai.photo.generativeWarning')}</p>
          <ul className="fine sm-ops">{ops.map((o, i) => <li key={i}><code dir="ltr">{String(o.op)}</code> <bdi dir="ltr">{JSON.stringify({ ...o, op: undefined })}</bdi></li>)}</ul>
        </details>
      )}
      {canWrite && job.status === 'review' && (
        <div className="stack" style={{ gap: 8 }}>
          <label className="field"><span>{t('studio.ai.photo.note')}</span><input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void act(() => call(`/o/${org.id}/studio/photos/${job.id}/review`, { body: { decision: 'approve', note: note || undefined } }), t('studio.ai.photo.approved'))}>{t('studio.ai.photo.approve')}</button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void act(() => call(`/o/${org.id}/studio/photos/${job.id}/review`, { body: { decision: 'reject', note: note || undefined } }), t('studio.ai.photo.rejectedOk'))}>{t('studio.ai.photo.reject')}</button>
          </div>
        </div>
      )}
      {job.published && <Notice tone="ok">{t(job.published.target === 'product' ? 'studio.ai.photo.publishedProduct' : 'studio.ai.photo.publishedSection')}</Notice>}
      {canWrite && publishable && (
        <div className="stack" style={{ gap: 8 }}>
          <h3 className="sm-h3">{t('studio.ai.photo.publish')}</h3>
          <div className="row" style={{ gap: 12 }}>
            <label className="row" style={{ gap: 6 }}><input type="radio" checked={target === 'product'} disabled={!can('menu:write')} onChange={() => { setTarget('product'); setTargetId(job.productId ?? ''); }} />{t('studio.ai.photo.toProduct')}</label>
            <label className="row" style={{ gap: 6 }}><input type="radio" checked={target === 'website_section'} onChange={() => { setTarget('website_section'); setTargetId(''); }} />{t('studio.ai.photo.toSection')}</label>
          </div>
          <select className="select" value={targetId} onChange={(e) => setTargetId(e.target.value)} aria-label={t('studio.ai.photo.publish')}>
            <option value="">—</option>
            {target === 'product'
              ? (products.data?.items ?? []).map((x) => <option key={x.id} value={x.id}>{locale === 'ar' && x.nameAr ? x.nameAr : x.name}</option>)
              : (site.data?.sections ?? []).map((s) => <option key={s.id} value={s.id}>{t(`studio.kind.${s.kind}`)}</option>)}
          </select>
          <p className="fine" style={{ margin: 0 }}>{t(target === 'product' ? 'studio.ai.photo.productHint' : 'studio.ai.photo.sectionHint')}</p>
          <div><button type="button" className="btn btn-primary" disabled={!targetId || busy}
            onClick={() => void act(() => call(`/o/${org.id}/studio/photos/${job.id}/publish`, {
              body: target === 'product' ? { target, productId: targetId, key: newIdempotencyKey() } : { target, sectionId: targetId, key: newIdempotencyKey() },
            }), t('studio.ai.photo.publishedOk'))}>{t('studio.ai.photo.publishCta')}</button></div>
        </div>
      )}
    </section>
  );
}
