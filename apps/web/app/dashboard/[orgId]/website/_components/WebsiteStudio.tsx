'use client';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PublicSite, SectionContent, UpdateWebsite } from '@resuto/contracts';
import { Badge, Notice, PageHeader, Skeleton, WorkspacePage, useConfirm, useToast } from '@resuto/ui';
import { ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import type { CanvasDevice, CanvasTarget } from '@/lib/studio-canvas';
import { DraftHistory, type DraftApi, type HistoryEntry } from '@/lib/studio-history';
import { Canvas } from './Canvas';
import { Navigator, type NavTab } from './Navigator';
import { StudioToolbar } from './StudioToolbar';
import type { InspectorMode, Proposal, SaveState, Studio, WebsiteState } from './types';
import './website.css';

// The inspector, the AI panel and version history are separate chunks: the workspace shell and the canvas frame load
// first (plan §9: the Studio canvas and its panels are lazy).
const Inspector = dynamic(() => import('./Inspector').then((m) => m.Inspector), { ssr: false, loading: () => <div className="ws-pane-pad"><Skeleton lines={6} /></div> });
const HistorySheet = dynamic(() => import('./HistoryPanel').then((m) => m.HistorySheet), { ssr: false });

/**
 * Resuto Studio (21-STUDIO, plan §6.4): a canvas workspace. Toolbar (page, device, language, undo/redo, save state,
 * preview, publish, versions) over a left navigator (pages, sections, assets, templates), the canvas (the draft in a
 * sandboxed iframe, app/studio-canvas) and the inspector (section and site settings, SEO, AI editing). Every edit goes
 * straight to the draft through the Studio API and is recorded in a client history stack for undo and redo; guests see
 * nothing until the owner publishes.
 */
export function WebsiteStudio({ orgId, can }: { orgId: string; can: (p: 'studio:write' | 'studio:publish') => boolean }) {
  const { t, locale } = useT();
  const session = useSession();
  const toast = useToast();
  const [confirm, dialog] = useConfirm(locale);
  const site = useApi<WebsiteState>(`/o/${orgId}/studio/website`);
  const [preview, setPreview] = useState<PublicSite | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [selected, setSelected] = useState<CanvasTarget | null>(null);
  const [device, setDevice] = useState<CanvasDevice>('desktop');
  const [canvasLocale, setCanvasLocale] = useState<'en' | 'ar'>(locale);
  const [save, setSave] = useState<SaveState>('saved');
  const [dirty, setDirty] = useState(false);
  const [focus, setFocus] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [compare, setCompare] = useState<'before' | 'after'>('after');
  const [, bump] = useState(0);
  const history = useRef(new DraftHistory()).current;
  const publishKey = useRef<{ key: string; rev: number } | null>(null);
  const canWrite = can('studio:write');
  const canPublish = can('studio:publish');

  // Deep links from the navigation: ?tab=domains opens the site inspector on Domains (21-SHELL).
  const search = useSearchParams();
  const wanted = search.get('tab');
  const initial = useMemo(() => {
    if (wanted === 'domains' || wanted === 'seo' || wanted === 'design') return { mode: 'site' as InspectorMode, siteTab: wanted, nav: 'sections' as NavTab };
    if (wanted === 'creative') return { mode: 'ai' as InspectorMode, siteTab: 'design', nav: 'sections' as NavTab };
    if (wanted === 'media') return { mode: 'section' as InspectorMode, siteTab: 'design', nav: 'assets' as NavTab };
    if (wanted === 'templates') return { mode: 'section' as InspectorMode, siteTab: 'design', nav: 'templates' as NavTab };
    return { mode: 'section' as InspectorMode, siteTab: 'design', nav: 'sections' as NavTab };
  }, [wanted]);
  const [mode, setMode] = useState<InspectorMode>(initial.mode);
  const [navTab, setNavTab] = useState<NavTab>(initial.nav);
  useEffect(() => { setMode(initial.mode); setNavTab(initial.nav); }, [initial]);
  useEffect(() => { if (wanted === 'history') setHistoryOpen(true); }, [wanted]);

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

  const api = useMemo<DraftApi>(() => {
    const base = `/o/${orgId}/studio/website`;
    return {
      updateWebsite: async (patch: UpdateWebsite) => { site.setData(await session.call<WebsiteState>(base, { method: 'PATCH', body: patch })); },
      createSection: (input) => session.call<{ id: string }>(`${base}/sections`, { body: input }),
      updateSection: async (id: string, patch: { content?: SectionContent; isVisible?: boolean }) => { await session.call(`${base}/sections/${id}`, { method: 'PATCH', body: patch }); },
      deleteSection: async (id: string) => { await session.call(`${base}/sections/${id}`, { method: 'DELETE' }); },
      reorderSections: async (ids: string[]) => { site.setData(await session.call<WebsiteState>(`${base}/sections/reorder`, { body: { ids } })); },
    };
  }, [orgId, session, site]);

  const fail = useCallback((e: unknown) => {
    setSave('error');
    toast.show({ message: e instanceof ApiRequestError || e instanceof Error ? e.message : t('state.error'), tone: 'danger' });
  }, [toast, t]);

  const edit = useCallback(async (entry: HistoryEntry) => {
    setSave('saving');
    try {
      await history.run(entry.forward, api);
      history.push(entry);
      await site.reload();
      setSave('saved');
      return true;
    } catch (e) {
      fail(e);
      await site.reload();
      return false;
    } finally {
      bump((n) => n + 1);
    }
  }, [api, history, site, fail]);

  const step = useCallback(async (dir: 'undo' | 'redo') => {
    const entry = dir === 'undo' ? history.takeUndo() : history.takeRedo();
    if (!entry) return;
    setSave('saving');
    try {
      await history.run(dir === 'undo' ? entry.backward : entry.forward, api);
      if (dir === 'undo') history.undone(entry); else history.redone(entry);
      setSave('saved');
      toast.show({ message: t(dir === 'undo' ? 'studio.ws.undone' : 'studio.ws.redone', { what: entry.label }), tone: 'ok' });
    } catch (e) {
      // The draft moved on (someone else edited it): this step is dropped rather than half-applied again.
      fail(e);
    } finally {
      await site.reload();
      bump((n) => n + 1);
    }
  }, [api, history, site, toast, t, fail]);

  const refresh = useCallback(async (opts: { clearHistory?: boolean } = {}) => {
    if (opts.clearHistory) history.clear();
    await site.reload();
    bump((n) => n + 1);
  }, [history, site]);

  const publish = useCallback(async () => {
    const w = site.data?.website;
    if (!w) return;
    if (!(await confirm({ title: t('studio.publish.title'), body: t('studio.publish.body'), confirmLabel: t('studio.publish.cta') }))) return;
    // One key per draft revision: a retried click cannot publish twice.
    if (!publishKey.current || publishKey.current.rev !== w.draftRevision) publishKey.current = { key: newIdempotencyKey(), rev: w.draftRevision };
    try {
      const res = await session.call<{ revision: number }>(`/o/${orgId}/studio/website/publish`, { body: { key: publishKey.current.key } });
      toast.show({ message: t('studio.publish.done', { n: res.revision }), tone: 'ok' });
      // Refresh the cached public page now (best effort; it also expires within 30 s).
      await fetch(`${site.data!.publicPath}/revalidate`, {
        method: 'POST', headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ orgId }),
      }).catch(() => undefined);
      await site.reload();
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'danger' });
    }
  }, [site, confirm, t, session, orgId, toast]);

  // Keyboard: Ctrl/⌘ Z undo, Ctrl/⌘ Shift Z or Ctrl Y redo (not while typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || !canWrite) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); void step('undo'); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); void step('redo'); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, canWrite]);

  const select = useCallback((id: CanvasTarget | null) => {
    setSelected(id);
    if (id && mode !== 'ai') setMode(id === 'site' ? 'site' : 'section');
  }, [mode]);

  if (site.error) return <div className="card"><Notice tone="danger">{site.error.message}</Notice><button className="btn mbs-12" onClick={() => void site.reload()}>{t('action.retry')}</button></div>;
  if (!site.data) return <div className="card"><Skeleton lines={6} /></div>;
  const w = site.data.website;
  const studio: Studio = {
    orgId, state: site.data, preview, canWrite, canPublish, selected, select, edit, history, refresh, setDirty, device, canvasLocale,
    proposal, setProposal: (p) => { setProposal(p); setCompare('after'); if (p) setMode('ai'); }, compare, setCompare, publish,
  };
  const shown = proposal && compare === 'after' && proposal.after ? proposal.after : preview;

  return (
    <>
      {dialog}
      <PageHeader overline={t('nav.website')} title={t('studio.website.title')}
        subtitle={<span className="row gap-8">
          {w.publishedRevision > 0
            ? <Badge tone="ok">{t('studio.website.published', { n: w.publishedRevision })}</Badge>
            : <Badge tone="warn">{t('studio.website.notPublished')}</Badge>}
          {w.hasUnpublishedChanges && <Badge tone="pay">{t('studio.website.unpublished')}</Badge>}
          {w.publishedAt && <span className="fine">{t('studio.website.publishedAt', { at: dateTime(w.publishedAt, locale) })}</span>}
        </span>} />
      <div className="ws-studio" data-focus={focus || undefined}>
        <WorkspacePage
          labels={{ toolbar: t('studio.ws.toolbar'), start: t('studio.ws.navigator'), main: t('studio.ws.canvas'), end: t('studio.ws.inspector') }}
          toolbar={<StudioToolbar studio={studio} save={dirty && save === 'saved' ? 'unsaved' : save} onDevice={setDevice} onLocale={setCanvasLocale}
            onUndo={() => void step('undo')} onRedo={() => void step('redo')} focus={focus} onFocus={setFocus} onHistory={() => setHistoryOpen(true)} />}
          start={focus ? undefined : <Navigator studio={studio} tab={navTab} onTab={setNavTab} />}
          end={focus ? undefined : <Inspector studio={studio} mode={mode} onMode={setMode} initialSiteTab={initial.siteTab} />}>
          {previewError ? <Notice tone="danger">{previewError}</Notice> : !shown ? <div className="ws-pane-pad"><Skeleton lines={8} /></div>
            : <Canvas site={shown} locale={canvasLocale} device={device} selected={selected} onSelect={select}
              compare={proposal ? compare : null} label={t('studio.ws.canvasFrame')} />}
        </WorkspacePage>
      </div>
      {historyOpen && <HistorySheet orgId={orgId} canWrite={canWrite} current={w.publishedRevision} open={historyOpen} onClose={() => setHistoryOpen(false)}
        onRestored={() => void refresh({ clearHistory: true })} />}
    </>
  );
}
