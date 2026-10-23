'use client';
import { useEffect, useState } from 'react';
import { SECTION_KINDS, type SectionContent, type WebsiteSeo, type WebsiteTheme } from '@resuto/contracts';
import { Drawer, EmptyState, useConfirm } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { MediaPicker } from './MediaLibrary';
import type { SectionRow, WebsiteState } from './types';

type Loc = { en?: string; ar?: string };

/** One copy field in both site languages (Arabic is RTL). */
export function LocalizedField({ label, value, onChange, max, multiline, hint }: {
  label: string; value: Loc | undefined; onChange: (v: Loc) => void; max: number; multiline?: boolean; hint?: string;
}) {
  const { t } = useT();
  const v = value ?? {};
  const Input = multiline ? 'textarea' : 'input';
  return (
    <fieldset className="ws-loc">
      <legend>{label}</legend>
      <label className="field"><span>{t('studio.lang.en')}</span>
        <Input className={multiline ? 'textarea' : 'input'} dir="ltr" lang="en" maxLength={max} value={v.en ?? ''} onChange={(e) => onChange({ ...v, en: e.target.value })} />
      </label>
      <label className="field"><span>{t('studio.lang.ar')}</span>
        <Input className={multiline ? 'textarea' : 'input'} dir="rtl" lang="ar" maxLength={max} value={v.ar ?? ''} onChange={(e) => onChange({ ...v, ar: e.target.value })} />
      </label>
      {hint && <small className="fine">{hint}</small>}
    </fieldset>
  );
}

function MediaField({ orgId, label, id, media, onChange, disabled }: {
  orgId: string; label: string; id: string | null | undefined; media: WebsiteState['media']; onChange: (id: string | null) => void; disabled?: boolean;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [local, setLocal] = useState<Record<string, string>>({});
  const url = id ? media[id]?.url ?? local[id] : null;
  return (
    <div className="field">
      <span>{label}</span>
      <div className="row">
        {url ? <img src={url} alt="" className="ws-thumb" /> : <span className="ws-thumb ws-thumb-empty" aria-hidden>▢</span>}
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => setOpen(true)}>{id ? t('studio.media.replace') : t('studio.media.choose')}</button>
        {id && <button type="button" className="btn btn-sm btn-ghost" disabled={disabled} onClick={() => onChange(null)}>{t('studio.media.remove')}</button>}
      </div>
      <MediaPicker orgId={orgId} open={open} onClose={() => setOpen(false)} selected={id ? [id] : []}
        onPick={(ids, items) => { setLocal(Object.fromEntries(items.map((m) => [m.id, m.url]))); onChange(ids[0] ?? null); }} />
    </div>
  );
}

// --- Design ----------------------------------------------------------------------
export function DesignPanel({ orgId, state, canWrite, onSave }: { orgId: string; state: WebsiteState; canWrite: boolean; onSave: (patch: { template?: string; theme?: WebsiteTheme }) => Promise<void> }) {
  const { t } = useT();
  const w = state.website;
  const [theme, setTheme] = useState<WebsiteTheme>(w.theme);
  useEffect(() => { setTheme(w.theme); }, [w.theme]);
  const templates = [
    { key: 'olive', name: t('studio.template.olive'), body: t('studio.template.oliveBody'), swatch: ['#173f36', '#faf9f5', '#C85E33'] },
    { key: 'smash', name: t('studio.template.smash'), body: t('studio.template.smashBody'), swatch: ['#b51218', '#ffd52f', '#fff8ed'] },
    { key: 'minimal', name: t('studio.template.minimal'), body: t('studio.template.minimalBody'), swatch: ['#163d34', '#ffffff', '#e1e5dd'] },
  ] as const;
  const color = (k: 'primaryColor' | 'accentColor' | 'backgroundColor', label: string) => (
    <label className="field"><span>{label}</span>
      <span className="row gap-8">
        <input type="color" className="ws-color" value={theme[k] ?? '#173f36'} disabled={!canWrite} onChange={(e) => setTheme({ ...theme, [k]: e.target.value })} aria-label={label} />
        <code className="fine">{theme[k] ?? t('studio.design.templateDefault')}</code>
        {theme[k] && canWrite && <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTheme({ ...theme, [k]: undefined })}>{t('studio.design.reset')}</button>}
      </span>
    </label>
  );
  const dirty = JSON.stringify(theme) !== JSON.stringify(w.theme);
  return (
    <div className="stack">
      <section className="card">
        <h2>{t('studio.design.template')}</h2>
        <div className="ws-templates" role="radiogroup" aria-label={t('studio.design.template')}>
          {templates.map((tp) => (
            <button key={tp.key} type="button" role="radio" aria-checked={w.template === tp.key} className="ws-template" disabled={!canWrite}
              onClick={() => void onSave({ template: tp.key })}>
              <span className="ws-swatch" aria-hidden>{tp.swatch.map((c) => <i key={c} style={{ background: c }} />)}</span>
              <strong>{tp.name}</strong>
              <small>{tp.body}</small>
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        <h2>{t('studio.design.brand')}</h2>
        <MediaField orgId={orgId} label={t('studio.design.logo')} id={theme.logoMediaId} media={state.media} disabled={!canWrite} onChange={(id) => setTheme({ ...theme, logoMediaId: id })} />
        <MediaField orgId={orgId} label={t('studio.design.heroImage')} id={theme.heroMediaId} media={state.media} disabled={!canWrite} onChange={(id) => setTheme({ ...theme, heroMediaId: id })} />
        <div className="form-row">
          {color('primaryColor', t('studio.design.primary'))}
          {color('accentColor', t('studio.design.accent'))}
          {color('backgroundColor', t('studio.design.background'))}
        </div>
        <label className="field"><span>{t('studio.design.font')}</span>
          <select className="select" value={theme.font ?? 'manrope'} disabled={!canWrite} onChange={(e) => setTheme({ ...theme, font: e.target.value as 'manrope' | 'editorial' })}>
            <option value="manrope">{t('studio.design.fontModern')}</option>
            <option value="editorial">{t('studio.design.fontEditorial')}</option>
          </select>
        </label>
        {canWrite && <button type="button" className="btn btn-primary" disabled={!dirty} onClick={() => void onSave({ theme })}>{t('action.save')}</button>}
      </section>
    </div>
  );
}

// --- SEO -------------------------------------------------------------------------------
export function SeoPanel({ orgId, state, canWrite, onSave }: { orgId: string; state: WebsiteState; canWrite: boolean; onSave: (patch: { seo: WebsiteSeo }) => Promise<void> }) {
  const { t } = useT();
  const [seo, setSeo] = useState<WebsiteSeo>(state.website.seo);
  useEffect(() => { setSeo(state.website.seo); }, [state.website.seo]);
  const dirty = JSON.stringify(seo) !== JSON.stringify(state.website.seo);
  return (
    <section className="card">
      <h2>{t('studio.seo.title')}</h2>
      <p className="fine">{t('studio.seo.hint')}</p>
      <LocalizedField label={t('studio.seo.pageTitle')} value={seo.title} max={70} onChange={(v) => setSeo({ ...seo, title: v })} hint={t('studio.seo.titleHint')} />
      <LocalizedField label={t('studio.seo.description')} value={seo.description} max={170} multiline onChange={(v) => setSeo({ ...seo, description: v })} hint={t('studio.seo.descriptionHint')} />
      <MediaField orgId={orgId} label={t('studio.seo.ogImage')} id={seo.ogMediaId} media={state.media} disabled={!canWrite} onChange={(id) => setSeo({ ...seo, ogMediaId: id })} />
      {canWrite && <button type="button" className="btn btn-primary" disabled={!dirty} onClick={() => void onSave({ seo })}>{t('action.save')}</button>}
    </section>
  );
}

// --- Sections ------------------------------------------------------------------------------
const HAS_MEDIA = new Set(['hero', 'about', 'custom']);
const HAS_CTA = new Set(['hero', 'reservations', 'ordering']);

export function SectionsPanel({ orgId, state, canWrite, call }: {
  orgId: string; state: WebsiteState; canWrite: boolean;
  call: (path: string, opts: { method?: 'POST' | 'PATCH' | 'DELETE'; body?: unknown }, success?: string) => Promise<boolean>;
}) {
  const { t, locale } = useT();
  const [confirm, dialog] = useConfirm(locale);
  const [editing, setEditing] = useState<SectionRow | null>(null);
  const [adding, setAdding] = useState<string>('about');
  const base = `/o/${orgId}/studio/website/sections`;
  const sections = state.sections;
  const move = (i: number, dir: -1 | 1) => {
    const ids = sections.map((s) => s.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    void call(`${base}/reorder`, { body: { ids } });
  };
  const title = (s: SectionRow) => (locale === 'ar' ? s.content.headline?.ar || s.content.headline?.en : s.content.headline?.en || s.content.headline?.ar) || t(`studio.kind.${s.kind}`);
  return (
    <section className="card">
      {dialog}
      <div className="spread"><h2 className="m-0">{t('studio.sections.title')}</h2></div>
      <p className="fine">{t('studio.sections.hint')}</p>
      {!sections.length ? <EmptyState title={t('studio.sections.emptyTitle')}>{t('studio.sections.emptyBody')}</EmptyState> : (
        <ol className="ws-sections">
          {sections.map((s, i) => (
            <li key={s.id} data-hidden={!s.isVisible || undefined}>
              <div className="ws-section-main">
                <span className="badge">{t(`studio.kind.${s.kind}`)}</span>
                <strong>{title(s)}</strong>
                {!s.isVisible && <span className="badge badge-warn">{t('studio.sections.hidden')}</span>}
              </div>
              {canWrite && (
                <div className="row ws-section-actions">
                  <button type="button" className="btn btn-sm btn-ghost" aria-label={t('studio.sections.moveUp', { name: title(s) })} disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                  <button type="button" className="btn btn-sm btn-ghost" aria-label={t('studio.sections.moveDown', { name: title(s) })} disabled={i === sections.length - 1} onClick={() => move(i, 1)}>↓</button>
                  <button type="button" className="btn btn-sm" aria-pressed={!s.isVisible}
                    onClick={() => void call(`${base}/${s.id}`, { method: 'PATCH', body: { isVisible: !s.isVisible } })}>{s.isVisible ? t('studio.sections.hide') : t('studio.sections.show')}</button>
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(s)}>{t('action.edit')}</button>
                  <button type="button" className="btn btn-sm btn-danger" aria-label={`${t('action.delete')} ${title(s)}`}
                    onClick={async () => { if (await confirm({ title: t('studio.sections.deleteTitle'), body: t('studio.sections.deleteBody'), confirmLabel: t('action.delete'), tone: 'danger' })) void call(`${base}/${s.id}`, { method: 'DELETE' }); }}>✕</button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}
      {canWrite && (
        <div className="row mbs-14">
          <label className="sr-only" htmlFor="ws-add-kind">{t('studio.sections.kind')}</label>
          <select id="ws-add-kind" className="select" style={{ width: 'auto' }} value={adding} onChange={(e) => setAdding(e.target.value)}>
            {SECTION_KINDS.map((k) => <option key={k} value={k}>{t(`studio.kind.${k}`)}</option>)}
          </select>
          <button type="button" className="btn" onClick={() => void call(base, { body: { kind: adding, content: {} } }, t('studio.sections.added'))}>{t('studio.sections.add')}</button>
        </div>
      )}
      <SectionDrawer orgId={orgId} section={editing} media={state.media} onClose={() => setEditing(null)}
        onSave={async (content) => { if (editing && (await call(`${base}/${editing.id}`, { method: 'PATCH', body: { content } }, t('state.saved')))) setEditing(null); }} />
    </section>
  );
}

function SectionDrawer({ orgId, section, media, onClose, onSave }: {
  orgId: string; section: SectionRow | null; media: WebsiteState['media']; onClose: () => void; onSave: (c: SectionContent) => Promise<void>;
}) {
  const { t, locale } = useT();
  const [c, setC] = useState<SectionContent>({});
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [galleryUrls, setGalleryUrls] = useState<Record<string, string>>({});
  useEffect(() => { setC(section?.content ?? {}); }, [section]);
  const products = useApi<{ items: Array<{ id: string; name: string; nameAr: string | null; category: string }> }>(section?.kind === 'menu_highlights' ? `/o/${orgId}/studio/products` : null);
  const kind = section?.kind ?? '';
  const set = (k: keyof SectionContent, v: unknown) => setC((prev) => ({ ...prev, [k]: v }));
  return (
    <Drawer open={!!section} onClose={onClose} locale={locale} width={520} title={section ? t(`studio.kind.${kind}`) : ''}
      footer={<><button type="button" className="btn" onClick={onClose}>{t('action.cancel')}</button><button type="button" className="btn btn-primary" onClick={() => void onSave(c)}>{t('action.save')}</button></>}>
      {section && (
        <div className="stack">
          <LocalizedField label={t('studio.field.eyebrow')} value={c.eyebrow} max={60} onChange={(v) => set('eyebrow', v)} />
          <LocalizedField label={t('studio.field.headline')} value={c.headline} max={140} onChange={(v) => set('headline', v)} />
          <LocalizedField label={t('studio.field.body')} value={c.body} max={2000} multiline onChange={(v) => set('body', v)} />
          {HAS_CTA.has(kind) && <LocalizedField label={t('studio.field.cta')} value={c.ctaLabel} max={40} onChange={(v) => set('ctaLabel', v)} />}
          {HAS_MEDIA.has(kind) && <MediaField orgId={orgId} label={t('studio.field.image')} id={c.mediaId} media={media} onChange={(id) => set('mediaId', id)} />}
          {kind === 'gallery' && (
            <div className="field">
              <span>{t('studio.field.gallery')}</span>
              <div className="row">
                {(c.mediaIds ?? []).map((id) => {
                  const url = media[id]?.url ?? galleryUrls[id];
                  return url ? <img key={id} src={url} alt="" className="ws-thumb" /> : <span key={id} className="ws-thumb ws-thumb-empty" />;
                })}
                <button type="button" className="btn btn-sm" onClick={() => setGalleryOpen(true)}>{t('studio.media.choose')}</button>
              </div>
              <MediaPicker orgId={orgId} open={galleryOpen} multiple selected={c.mediaIds ?? []} onClose={() => setGalleryOpen(false)}
                onPick={(ids, items) => { setGalleryUrls(Object.fromEntries(items.map((m) => [m.id, m.url]))); set('mediaIds', ids.slice(0, 24)); }} />
            </div>
          )}
          {kind === 'menu_highlights' && (
            <fieldset className="ws-loc">
              <legend>{t('studio.field.products')}</legend>
              <p className="fine">{t('studio.field.productsHint')}</p>
              {!products.data ? <p className="fine">{t('state.loading')}</p> : !products.data.items.length ? <p className="fine">{t('studio.field.noProducts')}</p> : (
                <div className="ws-product-list">
                  {products.data.items.map((p) => {
                    const on = (c.productIds ?? []).includes(p.id);
                    return (
                      <label key={p.id} className="check">
                        <input type="checkbox" checked={on} disabled={!on && (c.productIds ?? []).length >= 12}
                          onChange={(e) => set('productIds', e.target.checked ? [...(c.productIds ?? []), p.id] : (c.productIds ?? []).filter((x) => x !== p.id))} />
                        {locale === 'ar' && p.nameAr ? p.nameAr : p.name} <small className="fine">· {p.category}</small>
                      </label>
                    );
                  })}
                </div>
              )}
            </fieldset>
          )}
          {kind === 'testimonials' && (
            <fieldset className="ws-loc">
              <legend>{t('studio.field.quotes')}</legend>
              <p className="fine">{t('studio.field.quotesHint')}</p>
              {(c.items ?? []).map((item, i) => (
                <div key={i} className="stack" style={{ borderBlockEnd: '1px solid var(--line-soft)', paddingBlockEnd: 10 }}>
                  <LocalizedField label={t('studio.field.quote')} value={item.title} max={120} onChange={(v) => set('items', (c.items ?? []).map((x, j) => (j === i ? { ...x, title: v } : x)))} />
                  <LocalizedField label={t('studio.field.quoteBy')} value={item.body} max={600} onChange={(v) => set('items', (c.items ?? []).map((x, j) => (j === i ? { ...x, body: v } : x)))} />
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => set('items', (c.items ?? []).filter((_, j) => j !== i))}>{t('action.delete')}</button>
                </div>
              ))}
              <button type="button" className="btn btn-sm" disabled={(c.items ?? []).length >= 12} onClick={() => set('items', [...(c.items ?? []), { title: {} }])}>{t('action.add')}</button>
            </fieldset>
          )}
        </div>
      )}
    </Drawer>
  );
}
