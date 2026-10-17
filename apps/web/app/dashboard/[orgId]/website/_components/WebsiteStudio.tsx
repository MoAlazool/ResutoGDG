'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PublicSite } from '@resuto/contracts';
import { Badge, EmptyState, Notice, PageHeader, Skeleton, Tabs, useConfirm, useToast } from '@resuto/ui';
import { newIdempotencyKey } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { translate } from '@/lib/i18n';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import { SiteView } from '../../../../r/[slug]/_components/SiteView';
import { CreativePanel } from './CreativePanel';
import { DomainsPanel } from './DomainsPanel';
import { DesignPanel, SectionsPanel, SeoPanel } from './EditorPanels';
import { MediaLibrary } from './MediaLibrary';
import type { WebsiteState } from './types';
import './website.css';

type Tab = 'sections' | 'design' | 'seo' | 'media' | 'domains' | 'creative' | 'history';

export function WebsiteStudio({ orgId, can }: { orgId: string; can: (p: 'studio:write' | 'studio:publish') => boolean }) {
  const { t, locale } = useT();
  const session = useSession();
  const toast = useToast();
  const [confirm, dialog] = useConfirm(locale);
  const site = useApi<WebsiteState>(`/o/${orgId}/studio/website`);
  const [preview, setPreview] = useState<PublicSite | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLocale, setPreviewLocale] = useState<'en' | 'ar'>(locale);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [tab, setTab] = useState<Tab>('sections');
  const [publishing, setPublishing] = useState(false);
  const publishKey = useRef<{ key: string; rev: number } | null>(null);
  const canWrite = can('studio:write');
  const canPublish = can('studio:publish');

  const loadPreview = useCallback(async () => {
    try {
      setPreview(await session.call<PublicSite>(`/o/${orgId}/studio/website/preview`));
      setPreviewError(null);
    } catch (e) {
      setPreviewError((e as Error).message);
    }
  }, [session, orgId]);
  const draftRevision = site.data?.website.draftRevision;
  useEffect(() => { if (draftRevision !== undefined) void loadPreview(); }, [draftRevision, loadPreview]);

  /** Runs a mutation, then refreshes the draft (and so the live preview). */
  const call = useCallback(async (path: string, opts: { method?: 'POST' | 'PATCH' | 'DELETE'; body?: unknown }, success?: string) => {
    try {
      const res = await session.call(path, { method: opts.method ?? 'POST', body: opts.body ?? (opts.method === 'DELETE' ? undefined : {}) });
      if (res && typeof res === 'object' && 'website' in res && 'sections' in res) site.setData(res as WebsiteState);
      else await site.reload();
      if (success) toast.show({ message: success, tone: 'ok' });
      return true;
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'danger' });
      return false;
    }
  }, [session, site, toast]);

  const patchWebsite = async (patch: Record<string, unknown>) => { await call(`/o/${orgId}/studio/website`, { method: 'PATCH', body: patch }, t('state.saved')); };

  const publish = async () => {
    const w = site.data?.website;
    if (!w) return;
    if (!(await confirm({ title: t('studio.publish.title'), body: t('studio.publish.body'), confirmLabel: t('studio.publish.cta') }))) return;
    // One key per draft revision: a retried click cannot publish twice.
    if (!publishKey.current || publishKey.current.rev !== w.draftRevision) publishKey.current = { key: newIdempotencyKey(), rev: w.draftRevision };
    setPublishing(true);
    try {
      const res = await session.call<{ revision: number }>(`/o/${orgId}/studio/website/publish`, { body: { key: publishKey.current.key } });
      toast.show({ message: t('studio.publish.done', { n: res.revision }), tone: 'ok' });
      await site.reload();
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'danger' });
    } finally {
      setPublishing(false);
    }
  };

  if (site.error) return <div className="card"><Notice tone="danger">{site.error.message}</Notice><button className="btn" style={{ marginBlockStart: 12 }} onClick={() => void site.reload()}>{t('action.retry')}</button></div>;
  if (!site.data) return <div className="card"><Skeleton lines={6} /></div>;
  const w = site.data.website;
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'sections', label: t('studio.tab.sections') }, { key: 'design', label: t('studio.tab.design') }, { key: 'seo', label: t('studio.tab.seo') },
    { key: 'media', label: t('studio.tab.media') }, { key: 'domains', label: t('studio.tab.domains') }, { key: 'creative', label: t('studio.tab.creative') },
    { key: 'history', label: t('studio.tab.history') },
  ];
  const previewT = (k: string, v?: Record<string, string | number>) => translate(previewLocale, k, v);
  const showPreview = tab === 'sections' || tab === 'design' || tab === 'seo';

  return (
    <>
      {dialog}
      <PageHeader overline={t('nav.website')} title={t('studio.website.title')}
        subtitle={<span className="row" style={{ gap: 8 }}>
          {w.publishedRevision > 0
            ? <Badge tone="ok">{t('studio.website.published', { n: w.publishedRevision })}</Badge>
            : <Badge tone="warn">{t('studio.website.notPublished')}</Badge>}
          {w.hasUnpublishedChanges && <Badge tone="pay">{t('studio.website.unpublished')}</Badge>}
          {w.publishedAt && <span className="fine">{t('studio.website.publishedAt', { at: dateTime(w.publishedAt, locale) })}</span>}
        </span>}
        actions={<>
          {w.publishedRevision > 0 && <a className="btn" href={site.data.publicPath} target="_blank" rel="noopener">{t('studio.website.view')} ↗</a>}
          {canPublish && <button type="button" className="btn btn-primary" disabled={publishing || !w.hasUnpublishedChanges} onClick={() => void publish()}>{publishing ? t('state.loading') : t('studio.publish.cta')}</button>}
        </>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={t('studio.website.title')} />
      <div className={showPreview ? 'ws-layout' : undefined}>
        <div className="ws-editor">
          {tab === 'sections' && <SectionsPanel orgId={orgId} state={site.data} canWrite={canWrite} call={call} />}
          {tab === 'design' && <DesignPanel orgId={orgId} state={site.data} canWrite={canWrite} onSave={patchWebsite} />}
          {tab === 'seo' && <SeoPanel orgId={orgId} state={site.data} canWrite={canWrite} onSave={patchWebsite} />}
          {tab === 'media' && <MediaLibrary orgId={orgId} canWrite={canWrite} />}
          {tab === 'domains' && <DomainsPanel orgId={orgId} canManage={canPublish} />}
          {tab === 'creative' && <CreativePanel orgId={orgId} canWrite={canWrite} />}
          {tab === 'history' && <HistoryPanel orgId={orgId} canWrite={canWrite} current={w.publishedRevision} onRestored={() => void site.reload()} />}
        </div>
        {showPreview && (
          <aside className="ws-preview" aria-label={t('studio.preview.label')}>
            <div className="spread ws-preview-bar">
              <strong>{t('studio.preview.label')}</strong>
              <span className="row" style={{ gap: 6 }}>
                <span role="group" aria-label={t('studio.preview.language')} className="row" style={{ gap: 4 }}>
                  {(['en', 'ar'] as const).map((l) => <button key={l} type="button" className={`btn btn-sm ${previewLocale === l ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={previewLocale === l} onClick={() => setPreviewLocale(l)}>{l === 'en' ? 'EN' : 'ع'}</button>)}
                </span>
                <span role="group" aria-label={t('studio.preview.device')} className="row" style={{ gap: 4 }}>
                  {(['desktop', 'mobile'] as const).map((d) => <button key={d} type="button" className={`btn btn-sm ${device === d ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={device === d} onClick={() => setDevice(d)}>{t(`studio.preview.${d}`)}</button>)}
                </span>
              </span>
            </div>
            {previewError ? <Notice tone="danger">{previewError}</Notice> : !preview ? <Skeleton lines={8} /> : (
              <div className={`ws-frame ws-frame-${device}`}>
                <div className="ws-frame-inner" lang={previewLocale} dir={previewLocale === 'ar' ? 'rtl' : 'ltr'} inert>
                  <SiteView site={preview} locale={previewLocale} t={previewT} preview />
                </div>
              </div>
            )}
            <p className="fine">{t('studio.preview.note')}</p>
          </aside>
        )}
      </div>
    </>
  );
}

function HistoryPanel({ orgId, canWrite, current, onRestored }: { orgId: string; canWrite: boolean; current: number; onRestored: () => void }) {
  const { t, locale } = useT();
  const session = useSession();
  const toast = useToast();
  const [confirm, dialog] = useConfirm(locale);
  const revs = useApi<{ items: Array<{ revision: number; note: string | null; publishedAt: string; publishedBy: string | null; sectionCount: number }> }>(`/o/${orgId}/studio/website/revisions`);
  return (
    <section className="card">
      {dialog}
      <h2>{t('studio.history.title')}</h2>
      <p className="fine">{t('studio.history.hint')}</p>
      {revs.error ? <Notice tone="danger">{revs.error.message}</Notice> : !revs.data ? <Skeleton lines={3} /> : !revs.data.items.length ? (
        <EmptyState title={t('studio.history.emptyTitle')}>{t('studio.history.emptyBody')}</EmptyState>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>{t('studio.history.revision')}</th><th>{t('studio.history.when')}</th><th>{t('studio.history.by')}</th><th>{t('studio.history.sections')}</th><th /></tr></thead>
            <tbody>
              {revs.data.items.map((r) => (
                <tr key={r.revision}>
                  <td>#{r.revision} {r.revision === current && <Badge tone="ok">{t('studio.history.live')}</Badge>}{r.note && <div className="fine">{r.note}</div>}</td>
                  <td>{dateTime(r.publishedAt, locale)}</td>
                  <td>{r.publishedBy ?? '—'}</td>
                  <td className="num">{r.sectionCount}</td>
                  <td style={{ textAlign: 'end' }}>
                    {canWrite && (
                      <button type="button" className="btn btn-sm" onClick={async () => {
                        if (!(await confirm({ title: t('studio.history.restoreTitle', { n: r.revision }), body: t('studio.history.restoreBody'), confirmLabel: t('studio.history.restore') }))) return;
                        try { await session.call(`/o/${orgId}/studio/website/revisions/${r.revision}/restore`, { body: {} }); toast.show({ message: t('studio.history.restored', { n: r.revision }), tone: 'ok' }); onRestored(); }
                        catch (e) { toast.show({ message: (e as Error).message, tone: 'danger' }); }
                      }}>{t('studio.history.restore')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
