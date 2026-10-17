'use client';
import { useState, type FormEvent } from 'react';
import type { CreativeAsset } from '@resuto/contracts';
import { Badge, EmptyState, Notice, Skeleton, useToast } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';

const KINDS = ['caption', 'post', 'menu_description', 'website_copy'] as const;
const TONES = ['warm', 'playful', 'premium', 'direct'] as const;

export function CreativePanel({ orgId, canWrite }: { orgId: string; canWrite: boolean }) {
  const { t, locale } = useT();
  const session = useSession();
  const toast = useToast();
  const [filter, setFilter] = useState<'all' | 'draft' | 'approved' | 'rejected'>('all');
  const list = useApi<{ items: CreativeAsset[] }>(`/o/${orgId}/studio/creative${filter === 'all' ? '' : `?status=${filter}`}`);
  const products = useApi<{ items: Array<{ id: string; name: string; nameAr: string | null }> }>(`/o/${orgId}/studio/products`);
  const [form, setForm] = useState({ kind: 'caption' as (typeof KINDS)[number], locale: locale as 'en' | 'ar', brief: '', productId: '', tone: 'warm' as (typeof TONES)[number], variants: 2 });
  const [pending, setPending] = useState(false);
  const [latest, setLatest] = useState<CreativeAsset | null>(null);

  const generate = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      const res = await session.call<CreativeAsset>(`/o/${orgId}/studio/creative`, { body: { ...form, productId: form.productId || undefined } });
      setLatest(res);
      await list.reload();
    } catch (err) {
      toast.show({ message: (err as Error).message, tone: 'danger' });
    } finally {
      setPending(false);
    }
  };
  const review = async (c: CreativeAsset, status: 'approved' | 'rejected') => {
    try {
      const res = await session.call<CreativeAsset>(`/o/${orgId}/studio/creative/${c.id}`, { method: 'PATCH', body: { status } });
      if (latest?.id === c.id) setLatest(res);
      await list.reload();
    } catch (err) {
      toast.show({ message: (err as Error).message, tone: 'danger' });
    }
  };

  return (
    <div className="stack">
      {canWrite && (
        <section className="card">
          <h2>{t('studio.creative.title')}</h2>
          <p className="fine">{t('studio.creative.hint')}</p>
          <form onSubmit={generate}>
            <div className="form-row">
              <label className="field"><span>{t('studio.creative.kind')}</span>
                <select className="select" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as typeof form.kind })}>
                  {KINDS.map((k) => <option key={k} value={k}>{t(`studio.creative.kind.${k}`)}</option>)}
                </select>
              </label>
              <label className="field"><span>{t('studio.creative.language')}</span>
                <select className="select" value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value as 'en' | 'ar' })}>
                  <option value="en">{t('studio.lang.en')}</option><option value="ar">{t('studio.lang.ar')}</option>
                </select>
              </label>
              <label className="field"><span>{t('studio.creative.tone')}</span>
                <select className="select" value={form.tone} onChange={(e) => setForm({ ...form, tone: e.target.value as typeof form.tone })}>
                  {TONES.map((k) => <option key={k} value={k}>{t(`studio.creative.tone.${k}`)}</option>)}
                </select>
              </label>
            </div>
            <label className="field"><span>{t('studio.creative.product')}</span>
              <select className="select" value={form.productId} onChange={(e) => setForm({ ...form, productId: e.target.value })}>
                <option value="">{t('studio.creative.noProduct')}</option>
                {products.data?.items.map((p) => <option key={p.id} value={p.id}>{locale === 'ar' && p.nameAr ? p.nameAr : p.name}</option>)}
              </select>
            </label>
            <label className="field"><span>{t('studio.creative.brief')}</span>
              <textarea className="textarea" required minLength={3} maxLength={600} dir={form.locale === 'ar' ? 'rtl' : 'ltr'} value={form.brief}
                placeholder={t('studio.creative.briefPlaceholder')} onChange={(e) => setForm({ ...form, brief: e.target.value })} />
            </label>
            <button className="btn btn-primary" disabled={pending}>{pending ? t('studio.creative.generating') : t('studio.creative.generate')}</button>
          </form>
          {latest && <div style={{ marginBlockStart: 16 }}><CreativeCard c={latest} onReview={review} canWrite={canWrite} /></div>}
        </section>
      )}
      <section className="card">
        <div className="spread">
          <h2 style={{ margin: 0 }}>{t('studio.creative.library')}</h2>
          <select className="select" style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label={t('studio.creative.filter')}>
            {(['all', 'draft', 'approved', 'rejected'] as const).map((f) => <option key={f} value={f}>{t(`studio.creative.status.${f}`)}</option>)}
          </select>
        </div>
        {list.error ? <Notice tone="danger">{list.error.message}</Notice> : !list.data ? <Skeleton lines={3} /> : !list.data.items.length ? (
          <EmptyState title={t('studio.creative.emptyTitle')}>{t('studio.creative.emptyBody')}</EmptyState>
        ) : (
          <div className="stack" style={{ marginBlockStart: 12 }}>
            {list.data.items.map((c) => <CreativeCard key={c.id} c={c} onReview={review} canWrite={canWrite} at={dateTime(c.createdAt, locale)} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function CreativeCard({ c, onReview, canWrite, at }: { c: CreativeAsset; onReview: (c: CreativeAsset, s: 'approved' | 'rejected') => void; canWrite: boolean; at?: string }) {
  const { t } = useT();
  return (
    <article className="ws-creative">
      <div className="spread">
        <span className="row" style={{ gap: 6 }}>
          <Badge>{t(`studio.creative.kind.${c.kind}`)}</Badge>
          <Badge tone={c.status === 'approved' ? 'ok' : c.status === 'rejected' ? 'danger' : 'neutral'}>{t(`studio.creative.status.${c.status}`)}</Badge>
          {c.isFallback
            ? <Badge tone="sandbox">{t('studio.creative.fallback')}</Badge>
            : <Badge tone="info">{c.provider}{c.model ? ` · ${c.model}` : ''}</Badge>}
        </span>
        {at && <small className="fine">{at}</small>}
      </div>
      {c.isFallback && c.output.fallbackReason && <p className="fine">{t('studio.creative.fallbackWhy', { reason: c.output.fallbackReason })}</p>}
      <p className="fine"><strong>{t('studio.creative.brief')}:</strong> {c.prompt}</p>
      {c.output.variants.map((v, i) => (
        <blockquote key={i} className="ws-variant" dir={c.locale === 'ar' ? 'rtl' : 'ltr'} lang={c.locale}>
          {v.title && <strong>{v.title}</strong>}
          <p>{v.text}</p>
          {v.hashtags?.length ? <small>{v.hashtags.join(' ')}</small> : null}
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void navigator.clipboard?.writeText([v.title, v.text, v.hashtags?.join(' ')].filter(Boolean).join('\n\n')).catch(() => undefined)}>{t('studio.domains.copy')}</button>
        </blockquote>
      ))}
      {canWrite && c.status === 'draft' && (
        <div className="row">
          <button type="button" className="btn btn-sm btn-leaf" onClick={() => onReview(c, 'approved')}>{t('studio.creative.approve')}</button>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => onReview(c, 'rejected')}>{t('studio.creative.reject')}</button>
        </div>
      )}
    </article>
  );
}
