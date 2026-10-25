'use client';
import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { CREATIVE_CAMPAIGN_CHANNELS, CREATIVE_TARGETS_BY_KIND, type CreativeView, type StudioAiCapabilities } from '@resuto/contracts';
import { Badge, EmptyState, Notice, Skeleton, useToast } from '@resuto/ui';
import { newIdempotencyKey } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';

const KINDS = ['caption', 'post', 'menu_description', 'website_copy'] as const;
const TONES = ['warm', 'playful', 'premium', 'direct'] as const;
const FILTERS = ['all', 'draft', 'approved', 'used', 'rejected'] as const;
type Product = { id: string; name: string; nameAr: string | null };
type Section = { id: string; kind: string };

export function CreativePanel({ orgId, canWrite }: { orgId: string; canWrite: boolean }) {
  const { t, locale } = useT();
  const session = useSession();
  const toast = useToast();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('all');
  const list = useApi<{ items: CreativeView[] }>(`/o/${orgId}/studio/creative${filter === 'all' ? '' : `?status=${filter}`}`);
  const products = useApi<{ items: Product[] }>(`/o/${orgId}/studio/products`);
  const site = useApi<{ sections: Section[] }>(canWrite ? `/o/${orgId}/studio/website` : null);
  const caps = useApi<StudioAiCapabilities>(`/o/${orgId}/studio-ai/capabilities`);
  const [form, setForm] = useState({ kind: 'caption' as (typeof KINDS)[number], locale: locale as 'en' | 'ar', brief: '', productId: '', tone: 'warm' as (typeof TONES)[number], variants: 2 });
  const [pending, setPending] = useState(false);
  const [latest, setLatest] = useState<CreativeView | null>(null);

  const refresh = async (c?: CreativeView) => {
    if (c && latest?.id === c.id) setLatest(c);
    await list.reload();
  };
  const generate = async (e: FormEvent) => {
    e.preventDefault();
    setPending(true);
    try {
      const res = await session.call<CreativeView>(`/o/${orgId}/studio/creative`, { body: { ...form, productId: form.productId || undefined } });
      setLatest(res);
      await list.reload();
    } catch (err) {
      toast.show({ message: (err as Error).message, tone: 'danger' });
    } finally {
      setPending(false);
    }
  };
  const review = async (c: CreativeView, status: 'approved' | 'rejected') => {
    try {
      await refresh(await session.call<CreativeView>(`/o/${orgId}/studio/creative/${c.id}`, { method: 'PATCH', body: { status } }));
    } catch (err) {
      toast.show({ message: (err as Error).message, tone: 'danger' });
    }
  };
  const ctx = { orgId, canWrite, products: products.data?.items ?? [], sections: site.data?.sections ?? [], onReview: review, onApplied: refresh };

  return (
    <div className="stack">
      {canWrite && (
        <section className="card">
          <h2>{t('studio.creative.title')}</h2>
          <p className="fine">{t('studio.creative.hint')}</p>
          {caps.data && (
            <div className="ws-creative-mode"><Notice tone="info">
              {caps.data.copyGeneration.mode === 'template' ? t('studio.creative.modeTemplate')
                : t(caps.data.copyGeneration.keySource === 'restaurant' ? 'studio.creative.modeModelRestaurant' : 'studio.creative.modeModelResuto',
                  { model: caps.data.copyGeneration.model ?? '' })}
            </Notice></div>
          )}
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
          {latest && <div className="mbs-16"><CreativeCard c={latest} {...ctx} /></div>}
        </section>
      )}
      <section className="card">
        <div className="spread">
          <h2 className="m-0">{t('studio.creative.library')}</h2>
          <select className="select ws-select-auto" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)} aria-label={t('studio.creative.filter')}>
            {FILTERS.map((f) => <option key={f} value={f}>{t(`studio.creative.status.${f}`)}</option>)}
          </select>
        </div>
        {list.error ? <Notice tone="danger">{list.error.message}</Notice> : !list.data ? <Skeleton lines={3} /> : !list.data.items.length ? (
          <EmptyState title={t('studio.creative.emptyTitle')}>{t('studio.creative.emptyBody')}</EmptyState>
        ) : (
          <div className="stack mbs-12">
            {list.data.items.map((c) => <CreativeCard key={c.id} c={c} at={dateTime(c.createdAt, locale)} {...ctx} />)}
          </div>
        )}
      </section>
    </div>
  );
}

interface CardProps {
  c: CreativeView; at?: string; orgId: string; canWrite: boolean; products: Product[]; sections: Section[];
  onReview: (c: CreativeView, s: 'approved' | 'rejected') => void; onApplied: (c: CreativeView) => Promise<void>;
}

/** Honest authorship: a template is never shown as AI; a model result names the model and whose key wrote it. */
function Authorship({ c }: { c: CreativeView }) {
  const { t } = useT();
  const a = c.authorship;
  if (a.mode === 'template') return <Badge tone="sandbox">{t('studio.creative.byTemplate')}</Badge>;
  return <Badge tone="info">{t('studio.creative.byModel', { model: a.model ?? a.provider })}{' · '}{t(a.keySource === 'restaurant' ? 'studio.creative.keyRestaurant' : 'studio.creative.keyResuto')}</Badge>;
}

function CreativeCard(props: CardProps) {
  const { c, at, canWrite, onReview } = props;
  const { t } = useT();
  const usable = c.status === 'approved' || c.status === 'used';
  return (
    <article className="ws-creative">
      <div className="spread">
        <span className="row gap-6 wrap">
          <Badge>{t(`studio.creative.kind.${c.kind}`)}</Badge>
          <Badge tone={c.status === 'approved' || c.status === 'used' ? 'ok' : c.status === 'rejected' ? 'danger' : 'neutral'}>{t(`studio.creative.status.${c.status}`)}</Badge>
          <Authorship c={c} />
        </span>
        {at && <small className="fine">{at}</small>}
      </div>
      {c.authorship.fallbackCode && <p className="fine">{t(`studio.creative.fallbackCode.${c.authorship.fallbackCode}`)}</p>}
      <p className="fine"><strong>{t('studio.creative.brief')}:</strong> <span dir="auto">{c.prompt}</span></p>
      {c.output.variants.map((v, i) => (
        <blockquote key={i} className="ws-variant" dir={c.locale === 'ar' ? 'rtl' : 'ltr'} lang={c.locale}>
          {c.output.variants.length > 1 && <small>{t('studio.creative.version', { index: i + 1 })}</small>}
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
      {c.applications.length > 0 && <Applications {...props} />}
      {canWrite && usable && <ApplyBox {...props} />}
    </article>
  );
}

function Applications({ c, orgId, products, sections }: CardProps) {
  const { t, locale } = useT();
  const label = (target: string, id: string) => {
    if (target === 'product_description') {
      const p = products.find((x) => x.id === id);
      return { text: t('studio.creative.usedProduct', { name: p ? (locale === 'ar' && p.nameAr ? p.nameAr : p.name) : '' }), href: `/dashboard/${orgId}/menu` };
    }
    if (target === 'website_section') {
      const s = sections.find((x) => x.id === id);
      return { text: t('studio.creative.usedSection', { section: s ? t(`studio.kind.${s.kind}`) : '' }), href: `/dashboard/${orgId}/website` };
    }
    return { text: t('studio.creative.usedCampaign'), href: `/dashboard/${orgId}/marketing` };
  };
  return (
    <ul className="fine ws-applications">
      {c.applications.map((a) => {
        const l = label(a.target, a.targetId);
        return <li key={a.key}><Link href={l.href}>{l.text}</Link>{' · '}{dateTime(a.appliedAt, locale)}</li>;
      })}
    </ul>
  );
}

function ApplyBox({ c, orgId, products, sections, onApplied }: CardProps) {
  const { t, locale } = useT();
  const { can } = useOrg();
  const session = useSession();
  const toast = useToast();
  const target = (CREATIVE_TARGETS_BY_KIND[c.kind] ?? [])[0];
  const [variant, setVariant] = useState(0);
  const [productId, setProductId] = useState(c.output.productId ?? '');
  const [sectionId, setSectionId] = useState('');
  const [channel, setChannel] = useState<(typeof CREATIVE_CAMPAIGN_CHANNELS)[number]>('organic');
  const [key, setKey] = useState(() => newIdempotencyKey());
  const [busy, setBusy] = useState(false);
  if (!target) return null;
  const allowed = target === 'product_description' ? can('menu:write') : target === 'campaign_draft' ? can('marketing:write') : can('studio:write');
  const ready = target === 'product_description' ? !!productId : target === 'website_section' ? !!sectionId : true;
  const textSections = sections.filter((s) => ['hero', 'about', 'custom', 'ordering', 'reservations', 'contact'].includes(s.kind));

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    const body = {
      variant, key,
      target: target === 'product_description' ? { kind: target, productId } : target === 'website_section' ? { kind: target, sectionId } : { kind: target, channel },
    };
    try {
      const res = await session.call<CreativeView>(`/o/${orgId}/studio/creative/${c.id}/apply`, { body });
      toast.show({ message: t(`studio.creative.applied.${target}`), tone: 'ok' });
      setKey(newIdempotencyKey());
      await onApplied(res);
    } catch (err) {
      toast.show({ message: (err as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack ws-creative-use">
      <strong>{t('studio.creative.use')}</strong>
      {c.output.variants.length > 1 && (
        <div className="row gap-12 wrap" role="radiogroup" aria-label={t('studio.creative.useVersion')}>
          {c.output.variants.map((_, i) => (
            <label key={i} className="row gap-6"><input type="radio" checked={variant === i} onChange={() => setVariant(i)} />{t('studio.creative.version', { index: i + 1 })}</label>
          ))}
        </div>
      )}
      {target === 'product_description' && (
        <select className="select" value={productId} onChange={(e) => setProductId(e.target.value)} aria-label={t('studio.creative.toProduct')}>
          <option value="">{t('studio.creative.toProduct')}</option>
          {products.map((p) => <option key={p.id} value={p.id}>{locale === 'ar' && p.nameAr ? p.nameAr : p.name}</option>)}
        </select>
      )}
      {target === 'website_section' && (
        <select className="select" value={sectionId} onChange={(e) => setSectionId(e.target.value)} aria-label={t('studio.creative.toSection')}>
          <option value="">{t('studio.creative.toSection')}</option>
          {textSections.map((s) => <option key={s.id} value={s.id}>{t(`studio.kind.${s.kind}`)}</option>)}
        </select>
      )}
      {target === 'campaign_draft' && (
        <select className="select" value={channel} onChange={(e) => setChannel(e.target.value as typeof channel)} aria-label={t('studio.creative.toCampaign')}>
          {CREATIVE_CAMPAIGN_CHANNELS.map((ch) => <option key={ch} value={ch}>{t(`marketing.channel.${ch}`)}</option>)}
        </select>
      )}
      <p className="fine m-0">{t(`studio.creative.hint.${target}`, { language: t(`studio.lang.${c.locale}`) })}</p>
      {!allowed && <p className="fine m-0">{t('studio.creative.noPermission')}</p>}
      <div>
        <button type="button" className="btn btn-primary btn-sm" disabled={!ready || !allowed || busy} aria-busy={busy} onClick={() => void submit()}>
          {t(`studio.creative.cta.${target}`)}
        </button>
      </div>
    </div>
  );
}
