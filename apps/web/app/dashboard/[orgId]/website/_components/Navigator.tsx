'use client';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState } from 'react';
import { SECTION_KINDS } from '@resuto/contracts/lite';
import { Icon, Skeleton, Tabs, useConfirm } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { addEntry, deleteEntry, moved, reorderEntry, visibilityEntry } from '@/lib/studio-history';
import { ArrowDown, ArrowUp } from './studio-icons';
import type { SectionRow, Studio } from './types';

const Lazy = () => <div className="ws-pane-pad"><Skeleton lines={4} /></div>;
const MediaLibrary = dynamic(() => import('./MediaLibrary').then((m) => m.MediaLibrary), { ssr: false, loading: Lazy });
const TemplatesPanel = dynamic(() => import('./TemplatesPanel').then((m) => m.TemplatesPanel), { ssr: false, loading: Lazy });

export type NavTab = 'pages' | 'sections' | 'assets' | 'templates';

/** The section's own headline in the editor's language, else its kind. */
export function sectionTitle(s: Pick<SectionRow, 'kind' | 'content'>, locale: 'en' | 'ar', t: (k: string) => string) {
  const h = s.content.headline;
  return (locale === 'ar' ? h?.ar || h?.en : h?.en || h?.ar) || t(`studio.kind.${s.kind}`);
}

/** The left navigator: pages of the site, the draft's sections, assets (media library, food photos) and templates. */
export function Navigator({ studio, tab, onTab }: { studio: Studio; tab: NavTab; onTab: (t: NavTab) => void }) {
  const { t } = useT();
  return (
    <div className="ws-nav">
      <Tabs label={t('studio.ws.navigator')} value={tab} onChange={onTab} tabs={[
        { key: 'pages', label: t('studio.ws.nav.pages') }, { key: 'sections', label: t('studio.ws.nav.sections') },
        { key: 'assets', label: t('studio.ws.nav.assets') }, { key: 'templates', label: t('studio.ws.nav.templates') },
      ]} />
      {tab === 'pages' && <Pages studio={studio} />}
      {tab === 'sections' && <Sections studio={studio} />}
      {tab === 'assets' && (
        <div className="stack gap-12">
          <p className="fine m-0">{t('studio.ws.assetsHint')} <Link href={`/dashboard/${studio.orgId}/studio-media`}>{t('nav.foodPhotos')} ↗</Link></p>
          <MediaLibrary orgId={studio.orgId} canWrite={studio.canWrite} compact />
        </div>
      )}
      {tab === 'templates' && <TemplatesPanel studio={studio} />}
    </div>
  );
}

function Pages({ studio }: { studio: Studio }) {
  const { t } = useT();
  const slug = studio.state.publicPath.replace(/^\/r\//, '');
  const rows = [
    { key: 'home', label: t('studio.ws.page.home'), path: studio.state.publicPath, editable: true },
    { key: 'menu', label: t('studio.ws.page.menu'), path: `/m/${slug}`, editable: false },
    { key: 'order', label: t('studio.ws.page.order'), path: `/order/${slug}`, editable: false },
    { key: 'reserve', label: t('studio.ws.page.reserve'), path: `/reserve/${slug}`, editable: false },
  ];
  return (
    <ul className="ws-list">
      {rows.map((r) => (
        <li key={r.key} data-current={r.editable || undefined}>
          <span className="ws-list-main"><strong>{r.label}</strong><code className="fine" dir="ltr">{r.path}</code></span>
          {r.editable ? <span className="badge">{t('studio.ws.page.editing')}</span>
            : <a className="btn btn-sm btn-ghost" href={r.path} target="_blank" rel="noopener">{t('studio.ws.page.open')} ↗</a>}
        </li>
      ))}
      <li><p className="fine m-0">{t('studio.ws.page.hint')}</p></li>
    </ul>
  );
}

function Sections({ studio }: { studio: Studio }) {
  const { t, locale } = useT();
  const [confirm, dialog] = useConfirm(locale);
  const [adding, setAdding] = useState<string>('offers');
  const { sections } = studio.state;
  const { history } = studio;
  const order = sections.map((s) => history.refOf(s.id));
  const move = (i: number, dir: -1 | 1) => {
    const next = moved(order, i, dir);
    if (next !== order) void studio.edit(reorderEntry(t('studio.ws.h.move', { name: sectionTitle(sections[i]!, locale, t) }), order, next));
  };
  const add = async () => {
    const ref = `new:${crypto.randomUUID()}`;
    if (await studio.edit(addEntry(t('studio.ws.h.add', { kind: t(`studio.kind.${adding}`) }), ref, { kind: adding, content: {}, isVisible: true }))) {
      studio.select(history.idOf(ref));
    }
  };
  const remove = async (s: SectionRow) => {
    if (!(await confirm({ title: t('studio.sections.deleteTitle'), body: t('studio.sections.deleteBody'), confirmLabel: t('action.delete'), tone: 'danger' }))) return;
    await studio.edit(deleteEntry(t('studio.ws.h.delete', { name: sectionTitle(s, locale, t) }), history.refOf(s.id), s, order));
    if (studio.selected === s.id) studio.select(null);
  };
  return (
    <div className="stack gap-12">
      {dialog}
      {!sections.length ? <p className="fine">{t('studio.sections.emptyBody')}</p> : (
        <ol className="ws-list ws-sections" aria-label={t('studio.sections.title')}>
          {sections.map((s, i) => {
            const name = sectionTitle(s, locale, t);
            return (
              <li key={s.id} data-hidden={!s.isVisible || undefined} data-selected={studio.selected === s.id || undefined}>
                <button type="button" className="ws-list-main ws-list-pick" aria-pressed={studio.selected === s.id} onClick={() => studio.select(s.id)}>
                  <span className="badge">{t(`studio.kind.${s.kind}`)}</span>
                  <strong>{name}</strong>
                  {!s.isVisible && <span className="badge badge-warn">{t('studio.sections.hidden')}</span>}
                </button>
                {studio.canWrite && (
                  <span className="row gap-2 ws-section-actions">
                    <button type="button" className="btn btn-sm btn-ghost" aria-label={t('studio.sections.moveUp', { name })} disabled={i === 0} onClick={() => move(i, -1)}><Icon icon={ArrowUp} size={14} /></button>
                    <button type="button" className="btn btn-sm btn-ghost" aria-label={t('studio.sections.moveDown', { name })} disabled={i === sections.length - 1} onClick={() => move(i, 1)}><Icon icon={ArrowDown} size={14} /></button>
                    <button type="button" className="btn btn-sm btn-ghost" aria-pressed={!s.isVisible}
                      onClick={() => void studio.edit(visibilityEntry(t(s.isVisible ? 'studio.ws.h.hide' : 'studio.ws.h.show', { name }), history.refOf(s.id), !s.isVisible))}>
                      {s.isVisible ? t('studio.sections.hide') : t('studio.sections.show')}
                    </button>
                    <button type="button" className="btn btn-sm btn-ghost" aria-label={`${t('action.delete')} ${name}`} onClick={() => void remove(s)}>✕</button>
                  </span>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {studio.canWrite && (
        <div className="row gap-6">
          <label className="sr-only" htmlFor="ws-add-kind">{t('studio.sections.kind')}</label>
          <select id="ws-add-kind" className="select ws-grow" value={adding} onChange={(e) => setAdding(e.target.value)}>
            {SECTION_KINDS.map((k) => <option key={k} value={k}>{t(`studio.kind.${k}`)}</option>)}
          </select>
          <button type="button" className="btn btn-sm" onClick={() => void add()}>{t('studio.sections.add')}</button>
        </div>
      )}
    </div>
  );
}
