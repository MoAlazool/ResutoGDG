'use client';
import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';
import type { SectionContent, SectionLayout, WebsiteTheme } from '@resuto/contracts';
// Zod-free lists and rules: the editor's bundle stays out of the shared contracts module (bundle budget).
import { SECTION_ALIGNS, SECTION_SPACINGS, SECTION_TONES, TEMPLATE_FAMILIES, sectionContentIssues } from '@resuto/contracts/lite';
import { EmptyState, Notice, SegmentedControl, Skeleton, Tabs } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { contentEntry, websiteEntry } from '@/lib/studio-history';
import { LocalizedField, MediaField } from './EditorPanels';
import { MediaPicker } from './MediaLibrary';
import { sectionTitle } from './Navigator';
import type { InspectorMode, SectionRow, Studio } from './types';

const Lazy = () => <div className="ws-pane-pad"><Skeleton lines={5} /></div>;
const SeoInspector = dynamic(() => import('./SeoInspector').then((m) => m.SeoInspector), { ssr: false, loading: Lazy });
const DomainsPanel = dynamic(() => import('./DomainsPanel').then((m) => m.DomainsPanel), { ssr: false, loading: Lazy });
const AiPanel = dynamic(() => import('./AiPanel').then((m) => m.AiPanel), { ssr: false, loading: Lazy });

/** The right inspector: the selected section (content, layout), the whole site (design, SEO, domains) or AI editing. */
export function Inspector({ studio, mode, onMode, initialSiteTab }: { studio: Studio; mode: InspectorMode; onMode: (m: InspectorMode) => void; initialSiteTab: string }) {
  const { t } = useT();
  const section = studio.selected && studio.selected !== 'site' ? studio.state.sections.find((s) => s.id === studio.selected) ?? null : null;
  return (
    <div className="ws-inspector">
      <SegmentedControl label={t('studio.ws.inspector')} value={mode} onChange={onMode} options={[
        { value: 'section', label: t('studio.ws.mode.section') }, { value: 'site', label: t('studio.ws.mode.site') }, { value: 'ai', label: t('studio.ws.mode.ai') },
      ]} />
      {mode === 'section' && (section ? <SectionInspector key={section.id} studio={studio} section={section} />
        : <EmptyState title={t('studio.ws.pickTitle')}>{t('studio.ws.pickBody')}</EmptyState>)}
      {mode === 'site' && <SiteInspector studio={studio} initialTab={initialSiteTab} />}
      {mode === 'ai' && <AiPanel studio={studio} />}
    </div>
  );
}

// --- Section ---------------------------------------------------------------------------------------------------------
const COPY_KINDS_CTA = new Set(['hero', 'reservations', 'ordering', 'promo_banner']);
const MEDIA_KINDS = new Set(['hero', 'about', 'custom', 'promo_banner']);
const PRODUCT_KINDS = new Set(['menu_highlights', 'offers']);
const PROMO_KINDS = new Set(['offers', 'promo_banner']);

function SectionInspector({ studio, section }: { studio: Studio; section: SectionRow }) {
  const { t, locale } = useT();
  const [tab, setTab] = useState<'content' | 'layout'>('content');
  const [c, setC] = useState<SectionContent>(section.content);
  useEffect(() => { setC(section.content); }, [section.content]);
  const dirty = JSON.stringify(c) !== JSON.stringify(section.content);
  useEffect(() => { studio.setDirty(dirty); return () => studio.setDirty(false); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const issues = useMemo(() => sectionContentIssues(section.kind, c as Record<string, unknown>), [section.kind, c]);
  const set = <K extends keyof SectionContent>(k: K, v: SectionContent[K]) => setC((prev) => ({ ...prev, [k]: v }));
  const kind = section.kind;
  const name = sectionTitle(section, locale, t);
  const save = () => void studio.edit(contentEntry(t('studio.ws.h.edit', { name }), studio.history.refOf(section.id), section.content, c));
  const layout = c.layout ?? {};
  const setLayout = (patch: Partial<SectionLayout>) => set('layout', Object.fromEntries(Object.entries({ ...layout, ...patch }).filter(([, v]) => v !== undefined)) as SectionLayout);
  const disabled = !studio.canWrite;
  return (
    <div className="stack gap-12">
      <div><span className="badge">{t(`studio.kind.${kind}`)}</span> <strong>{name}</strong></div>
      <Tabs label={t('studio.ws.sectionTabs')} value={tab} onChange={setTab} tabs={[{ key: 'content', label: t('studio.ws.tab.content') }, { key: 'layout', label: t('studio.ws.tab.layout') }]} />
      <fieldset className="ws-fieldset" disabled={disabled}>
        {tab === 'content' && (
          <div className="stack gap-8">
            <LocalizedField label={t('studio.field.eyebrow')} value={c.eyebrow} max={60} onChange={(v) => set('eyebrow', v)} />
            <LocalizedField label={kind === 'faq' ? t('studio.field.sectionTitle') : t('studio.field.headline')} value={c.headline} max={140} onChange={(v) => set('headline', v)} />
            <LocalizedField label={t('studio.field.body')} value={c.body} max={2000} multiline onChange={(v) => set('body', v)} />
            {COPY_KINDS_CTA.has(kind) && <LocalizedField label={t('studio.field.cta')} value={c.ctaLabel} max={40} onChange={(v) => set('ctaLabel', v)} />}
            {MEDIA_KINDS.has(kind) && <MediaField orgId={studio.orgId} label={t('studio.field.image')} id={c.mediaId} media={studio.state.media} onChange={(id) => set('mediaId', id)} />}
            {PROMO_KINDS.has(kind) && <>
              <LocalizedField label={t('studio.field.badge')} value={c.badge} max={30} onChange={(v) => set('badge', v)} hint={t('studio.field.badgeHint')} />
              <label className="field"><span>{t('studio.field.promotionCode')}</span>
                <input className="input" dir="ltr" maxLength={32} value={c.promotionCode ?? ''} onChange={(e) => set('promotionCode', e.target.value.trim() ? e.target.value.trim().toUpperCase() : null)} />
                <small className="fine">{t('studio.field.promotionCodeHint')}</small>
              </label>
            </>}
            {PRODUCT_KINDS.has(kind) && <ProductPicker orgId={studio.orgId} value={c.productIds ?? []} onChange={(ids) => set('productIds', ids)} hint={kind === 'offers' ? t('studio.field.offersHint') : t('studio.field.productsHint')} />}
            {(kind === 'testimonials' || kind === 'faq') && <ItemsField kind={kind} value={c.items ?? []} onChange={(items) => set('items', items)} />}
            {kind === 'gallery' && <GalleryField orgId={studio.orgId} media={studio.state.media} value={c.mediaIds ?? []} onChange={(ids) => set('mediaIds', ids)} />}
            {kind === 'menu_full' && <CategoryPicker orgId={studio.orgId} value={c.categoryIds ?? []} onChange={(ids) => set('categoryIds', ids)} />}
            {kind === 'social' && <Notice tone="info">{t('studio.field.socialHint')}</Notice>}
          </div>
        )}
        {tab === 'layout' && (
          <div className="stack gap-12">
            <SegmentedControl size="sm" label={t('studio.layout.align')} value={layout.align ?? 'start'} onChange={(v) => setLayout({ align: v === 'start' ? undefined : v })}
              options={SECTION_ALIGNS.map((v) => ({ value: v, label: t(`studio.layout.align.${v}`) }))} />
            <SegmentedControl size="sm" label={t('studio.layout.spacing')} value={layout.spacing ?? 'normal'} onChange={(v) => setLayout({ spacing: v === 'normal' ? undefined : v })}
              options={SECTION_SPACINGS.map((v) => ({ value: v, label: t(`studio.layout.spacing.${v}`) }))} />
            <SegmentedControl size="sm" label={t('studio.layout.tone')} value={layout.tone ?? 'default'} onChange={(v) => setLayout({ tone: v === 'default' ? undefined : v })}
              options={SECTION_TONES.map((v) => ({ value: v, label: t(`studio.layout.tone.${v}`) }))} />
            {(PRODUCT_KINDS.has(kind) || kind === 'menu_full') && (
              <SegmentedControl size="sm" label={t('studio.layout.columns')} value={String(layout.columns ?? 3) as '2' | '3' | '4'}
                onChange={(v) => setLayout({ columns: v === '3' ? undefined : (Number(v) as 2 | 4) })}
                options={(['2', '3', '4'] as const).map((v) => ({ value: v, label: v }))} />
            )}
            <p className="fine m-0">{t('studio.layout.hint')}</p>
          </div>
        )}
      </fieldset>
      {issues.length > 0 && <Notice tone="warn">{issues.map((i) => i.message).join(' · ')}</Notice>}
      {studio.canWrite && (
        <div className="row gap-6">
          <button type="button" className="btn btn-primary" disabled={!dirty || issues.length > 0} onClick={save}>{t('studio.ws.apply')}</button>
          <button type="button" className="btn btn-ghost" disabled={!dirty} onClick={() => setC(section.content)}>{t('studio.ws.discard')}</button>
        </div>
      )}
    </div>
  );
}

function ProductPicker({ orgId, value, onChange, hint }: { orgId: string; value: string[]; onChange: (ids: string[]) => void; hint: string }) {
  const { t, locale } = useT();
  const products = useApi<{ items: Array<{ id: string; name: string; nameAr: string | null; category: string }> }>(`/o/${orgId}/studio/products`);
  return (
    <fieldset className="ws-loc">
      <legend>{t('studio.field.products')}</legend>
      <p className="fine">{hint}</p>
      {!products.data ? <p className="fine">{t('state.loading')}</p> : !products.data.items.length ? <p className="fine">{t('studio.field.noProducts')}</p> : (
        <div className="ws-product-list">
          {products.data.items.map((p) => {
            const on = value.includes(p.id);
            return (
              <label key={p.id} className="check">
                <input type="checkbox" checked={on} disabled={!on && value.length >= 12} onChange={(e) => onChange(e.target.checked ? [...value, p.id] : value.filter((x) => x !== p.id))} />
                {locale === 'ar' && p.nameAr ? p.nameAr : p.name} <small className="fine">· {p.category}</small>
              </label>
            );
          })}
        </div>
      )}
    </fieldset>
  );
}

function GalleryField({ orgId, media, value, onChange }: { orgId: string; media: Studio['state']['media']; value: string[]; onChange: (ids: string[]) => void }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [urls, setUrls] = useState<Record<string, string>>({});
  return (
    <div className="field">
      <span>{t('studio.field.gallery')}</span>
      <div className="row">
        {value.map((id) => {
          const url = media[id]?.url ?? urls[id];
          return url ? <img key={id} src={url} alt="" className="ws-thumb" /> : <span key={id} className="ws-thumb ws-thumb-empty" />;
        })}
        <button type="button" className="btn btn-sm" onClick={() => setOpen(true)}>{t('studio.media.choose')}</button>
      </div>
      <MediaPicker orgId={orgId} open={open} multiple selected={value} onClose={() => setOpen(false)}
        onPick={(ids, items) => { setUrls(Object.fromEntries(items.map((m) => [m.id, m.url]))); onChange(ids.slice(0, 24)); }} />
    </div>
  );
}

function CategoryPicker({ orgId, value, onChange }: { orgId: string; value: string[]; onChange: (ids: string[]) => void }) {
  const { t, locale } = useT();
  const menu = useApi<{ categories: Array<{ id: string; name: string; nameAr: string | null }> }>(`/o/${orgId}/menu`);
  const items = menu.data?.categories;
  return (
    <fieldset className="ws-loc">
      <legend>{t('studio.field.categories')}</legend>
      <p className="fine">{t('studio.field.categoriesHint')}</p>
      {!items ? <p className="fine">{t('state.loading')}</p> : (
        <div className="ws-product-list">
          {items.map((c) => (
            <label key={c.id} className="check">
              <input type="checkbox" checked={value.includes(c.id)} onChange={(e) => onChange(e.target.checked ? [...value, c.id] : value.filter((x) => x !== c.id))} />
              {locale === 'ar' && c.nameAr ? c.nameAr : c.name}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

function ItemsField({ kind, value, onChange }: { kind: 'faq' | 'testimonials'; value: NonNullable<SectionContent['items']>; onChange: (v: NonNullable<SectionContent['items']>) => void }) {
  const { t } = useT();
  const faq = kind === 'faq';
  return (
    <fieldset className="ws-loc">
      <legend>{faq ? t('studio.field.questions') : t('studio.field.quotes')}</legend>
      <p className="fine">{faq ? t('studio.field.questionsHint') : t('studio.field.quotesHint')}</p>
      {value.map((item, i) => (
        <div key={i} className="stack gap-6 ws-item">
          <LocalizedField label={faq ? t('studio.field.question') : t('studio.field.quote')} value={item.title} max={120} onChange={(v) => onChange(value.map((x, j) => (j === i ? { ...x, title: v } : x)))} />
          <LocalizedField label={faq ? t('studio.field.answer') : t('studio.field.quoteBy')} value={item.body} max={600} multiline={faq} onChange={(v) => onChange(value.map((x, j) => (j === i ? { ...x, body: v } : x)))} />
          <button type="button" className="btn btn-sm btn-danger" onClick={() => onChange(value.filter((_, j) => j !== i))}>{t('action.delete')}</button>
        </div>
      ))}
      <button type="button" className="btn btn-sm" disabled={value.length >= 12} onClick={() => onChange([...value, { title: {} }])}>{t('action.add')}</button>
    </fieldset>
  );
}

// --- Site -----------------------------------------------------------------------------------------------------------
type SiteTab = 'design' | 'seo' | 'domains';

function SiteInspector({ studio, initialTab }: { studio: Studio; initialTab: string }) {
  const { t } = useT();
  const [tab, setTab] = useState<SiteTab>((['design', 'seo', 'domains'] as const).includes(initialTab as SiteTab) ? initialTab as SiteTab : 'design');
  return (
    <div className="stack gap-12">
      <Tabs label={t('studio.ws.siteTabs')} value={tab} onChange={setTab} tabs={[
        { key: 'design', label: t('studio.tab.design') }, { key: 'seo', label: t('studio.tab.seo') }, { key: 'domains', label: t('studio.tab.domains') },
      ]} />
      {tab === 'design' && <DesignInspector studio={studio} />}
      {tab === 'seo' && <SeoInspector studio={studio} />}
      {tab === 'domains' && <DomainsPanel orgId={studio.orgId} canManage={studio.canPublish} />}
    </div>
  );
}

function DesignInspector({ studio }: { studio: Studio }) {
  const { t } = useT();
  const w = studio.state.website;
  const [theme, setTheme] = useState<WebsiteTheme>(w.theme);
  const [template, setTemplate] = useState(w.template);
  useEffect(() => { setTheme(w.theme); setTemplate(w.template); }, [w.theme, w.template]);
  const dirty = JSON.stringify(theme) !== JSON.stringify(w.theme) || template !== w.template;
  useEffect(() => { studio.setDirty(dirty); return () => studio.setDirty(false); }, [dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  // The renderer's own colours when the owner has not chosen any (the first family that uses it).
  const defaults = TEMPLATE_FAMILIES.find((f) => f.renderer === template)?.theme;
  const color = (k: 'primaryColor' | 'accentColor' | 'backgroundColor', label: string) => (
    <label className="field"><span>{label}</span>
      <span className="row gap-8">
        <input type="color" className="ws-color" value={theme[k] ?? defaults?.[k] ?? TEMPLATE_FAMILIES[0]!.theme[k]} onChange={(e) => setTheme({ ...theme, [k]: e.target.value })} aria-label={label} />
        <code className="fine">{theme[k] ?? t('studio.design.templateDefault')}</code>
        {theme[k] && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTheme({ ...theme, [k]: undefined })}>{t('studio.design.reset')}</button>}
      </span>
    </label>
  );
  const save = () => void studio.edit(websiteEntry(t('studio.ws.h.design'), { template: w.template, theme: w.theme }, { template, theme }));
  return (
    <fieldset className="ws-fieldset stack gap-8" disabled={!studio.canWrite}>
      <label className="field"><span>{t('studio.design.template')}</span>
        <select className="select" value={template} onChange={(e) => setTemplate(e.target.value as typeof template)}>
          {(['olive', 'smash', 'minimal'] as const).map((k) => <option key={k} value={k}>{t(`studio.template.${k}`)}</option>)}
        </select>
      </label>
      <h3 className="ws-h3">{t('studio.ws.typography')}</h3>
      <label className="field"><span>{t('studio.design.font')}</span>
        <select className="select" value={theme.font ?? 'manrope'} onChange={(e) => setTheme({ ...theme, font: e.target.value as 'manrope' | 'editorial' })}>
          <option value="manrope">{t('studio.design.fontModern')}</option>
          <option value="editorial">{t('studio.design.fontEditorial')}</option>
        </select>
      </label>
      <LocalizedField label={t('studio.design.tagline')} value={theme.tagline} max={80} onChange={(v) => setTheme({ ...theme, tagline: v })} />
      <h3 className="ws-h3">{t('studio.ws.colours')}</h3>
      {color('primaryColor', t('studio.design.primary'))}
      {color('accentColor', t('studio.design.accent'))}
      {color('backgroundColor', t('studio.design.background'))}
      <h3 className="ws-h3">{t('studio.design.brand')}</h3>
      <MediaField orgId={studio.orgId} label={t('studio.design.logo')} id={theme.logoMediaId} media={studio.state.media} onChange={(id) => setTheme({ ...theme, logoMediaId: id })} />
      <MediaField orgId={studio.orgId} label={t('studio.design.heroImage')} id={theme.heroMediaId} media={studio.state.media} onChange={(id) => setTheme({ ...theme, heroMediaId: id })} />
      {studio.canWrite && <div className="row gap-6">
        <button type="button" className="btn btn-primary" disabled={!dirty} onClick={save}>{t('studio.ws.apply')}</button>
        <button type="button" className="btn btn-ghost" disabled={!dirty} onClick={() => { setTheme(w.theme); setTemplate(w.template); }}>{t('studio.ws.discard')}</button>
      </div>}
    </fieldset>
  );
}
