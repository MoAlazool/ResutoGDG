'use client';
import { Icon, Menu, SegmentedControl } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import type { CanvasDevice } from '@/lib/studio-canvas';
import { Monitor, Redo2, Smartphone, Tablet, Undo2 } from './studio-icons';
import type { SaveState, Studio } from './types';

/**
 * The workspace toolbar: page, device, canvas language, undo/redo (the client history), save state, the before/after
 * switch of an AI proposal, preview (canvas only), version history and publish.
 */
export function StudioToolbar({ studio, save, onDevice, onLocale, onUndo, onRedo, focus, onFocus, onHistory }: {
  studio: Studio; save: SaveState; onDevice: (d: CanvasDevice) => void; onLocale: (l: 'en' | 'ar') => void;
  onUndo: () => void; onRedo: () => void; focus: boolean; onFocus: (on: boolean) => void; onHistory: () => void;
}) {
  const { t } = useT();
  const { state, history, canWrite, canPublish } = studio;
  const w = state.website;
  const slug = state.publicPath.replace(/^\/r\//, '');
  const pages = [
    { key: 'home', label: t('studio.ws.page.home') },
    { key: 'menu', label: t('studio.ws.page.menu'), href: `/m/${slug}` },
    { key: 'order', label: t('studio.ws.page.order'), href: `/order/${slug}` },
  ];
  return (
    <>
      <Menu label={t('studio.ws.page.label')} items={pages.map((p) => p.href
        ? { key: p.key, label: `${p.label} ↗`, text: p.label, href: p.href }
        : { key: p.key, label: p.label, onSelect: () => undefined, hint: t('studio.ws.page.editing') })}
        trigger={<button type="button" className="btn btn-sm">{t('studio.ws.page.current', { page: pages[0]!.label })}</button>} />
      <SegmentedControl size="sm" label={t('studio.preview.device')} value={studio.device} onChange={onDevice} options={[
        { value: 'desktop', label: <span className="sr-only">{t('studio.preview.desktop')}</span>, icon: <Icon icon={Monitor} size={16} /> },
        { value: 'tablet', label: <span className="sr-only">{t('studio.preview.tablet')}</span>, icon: <Icon icon={Tablet} size={16} /> },
        { value: 'phone', label: <span className="sr-only">{t('studio.preview.mobile')}</span>, icon: <Icon icon={Smartphone} size={16} /> },
      ]} />
      <SegmentedControl size="sm" label={t('studio.preview.language')} value={studio.canvasLocale} onChange={onLocale}
        options={[{ value: 'en', label: 'EN' }, { value: 'ar', label: 'ع' }]} />
      {canWrite && (
        <span className="row gap-4">
          <button type="button" className="btn btn-sm btn-ghost" disabled={!history.canUndo} onClick={onUndo}
            aria-label={history.undoLabel ? t('studio.ws.undoWhat', { what: history.undoLabel }) : t('studio.ws.undo')} title={t('studio.ws.undoKeys')}>
            <Icon icon={Undo2} size={16} />
          </button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={!history.canRedo} onClick={onRedo}
            aria-label={history.redoLabel ? t('studio.ws.redoWhat', { what: history.redoLabel }) : t('studio.ws.redo')} title={t('studio.ws.redoKeys')}>
            <Icon icon={Redo2} size={16} />
          </button>
        </span>
      )}
      <span className="ws-save fine" role="status" data-state={save}>{t(`studio.ws.save.${save}`)}</span>
      {studio.proposal?.after && (
        <SegmentedControl size="sm" label={t('studio.ai.compare')} value={studio.compare} onChange={studio.setCompare}
          options={[{ value: 'before', label: t('studio.ai.before') }, { value: 'after', label: t('studio.ai.after') }]} />
      )}
      <span className="ws-toolbar-end row gap-6">
        <button type="button" className="btn btn-sm" aria-pressed={focus} onClick={() => onFocus(!focus)}>{focus ? t('studio.ws.exitPreview') : t('studio.ws.preview')}</button>
        <button type="button" className="btn btn-sm" onClick={onHistory}>{t('studio.ws.versions')}</button>
        {w.publishedRevision > 0 && <a className="btn btn-sm" href={state.publicPath} target="_blank" rel="noopener">{t('studio.website.view')} ↗</a>}
        {canPublish && <button type="button" className="btn btn-sm btn-primary" disabled={!w.hasUnpublishedChanges} onClick={() => void studio.publish()}>{t('studio.publish.cta')}</button>}
      </span>
    </>
  );
}
