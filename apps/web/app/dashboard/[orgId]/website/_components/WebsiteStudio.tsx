'use client';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeSetView, PublicSite, SectionContent, StudioAiPlan, UpdateWebsite } from '@resuto/contracts';
import { Badge, Notice, PageHeader, Skeleton, WorkspacePage, useConfirm, useToast } from '@resuto/ui';
import { ApiRequestError, newIdempotencyKey } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { useSession } from '@/lib/session';
import type { AuditArea, AuditFix } from '@/lib/site-audit';
import type { CanvasDevice, CanvasTarget } from '@/lib/studio-canvas';
import { addEntry, DraftHistory, type DraftApi, type HistoryEntry } from '@/lib/studio-history';
import { Navigator, type NavTab } from './Navigator';
import { StudioToolbar } from './StudioToolbar';
import type { InspectorMode, Proposal, SaveState, Studio, StudioWorkspace, WebsiteState } from './types';
import './website.css';

// The inspector, the AI panel and version history are separate chunks: the workspace shell and the canvas frame load
// first (plan §9: the Studio canvas and its panels are lazy).
const Inspector = dynamic(() => import('./Inspector').then((m) => m.Inspector), { ssr: false, loading: () => <div className="ws-pane-pad"><Skeleton lines={6} /></div> });
const HistorySheet = dynamic(() => import('./HistoryPanel').then((m) => m.HistorySheet), { ssr: false });
// The canvas carries the site renderer (SiteView and its stylesheet): its own chunk, loaded with the workspace.
const Canvas = dynamic(() => import('./Canvas').then((m) => m.Canvas), { ssr: false, loading: () => <div className="ws-pane-pad"><Skeleton lines={8} /></div> });
// The Optimize workspace (22-STUDIO: SEO, AEO, GEO) is its own chunk, loaded when it is opened.
const OptimizeWorkspace = dynamic(() => import('./OptimizeWorkspace').then((m) => m.OptimizeWorkspace), { ssr: false, loading: () => <div className="ws-pane-pad"><Skeleton lines={10} /></div> });

/**
 * Resuto Studio (21-STUDIO, plan §6.4): a canvas workspace. Toolbar (page, device, language, undo/redo, save state,
 * preview, publish, versions) over a left navigator (pages, sections, assets, templates), the canvas (the draft rendered
 * into a script-free frame, Canvas.tsx and lib/studio-canvas.ts) and the inspector (section and site settings, SEO, AI editing). Every edit goes
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
  const initial = useMemo((): { mode: InspectorMode; siteTab: string; nav: NavTab; workspace?: StudioWorkspace; area?: AuditArea } => {
    // 22-STUDIO: search, answers and AI engines live in the Optimize workspace (?tab=seo|aeo|geo|optimize).
    if (wanted === 'seo' || wanted === 'aeo' || wanted === 'geo' || wanted === 'optimize') {
      return { mode: 'site' as InspectorMode, siteTab: 'design', nav: 'sections' as NavTab, workspace: 'optimize' as StudioWorkspace, area: (wanted === 'optimize' ? 'seo' : wanted) as AuditArea };
    }
    if (wanted === 'domains' || wanted === 'design') return { mode: 'site' as InspectorMode, siteTab: wanted, nav: 'sections' as NavTab };
    if (wanted === 'creative') return { mode: 'ai' as InspectorMode, siteTab: 'design', nav: 'sections' as NavTab };
    if (wanted === 'media') return { mode: 'section' as InspectorMode, siteTab: 'design', nav: 'assets' as NavTab };
    if (wanted === 'templates') return { mode: 'section' as InspectorMode, siteTab: 'design', nav: 'templates' as NavTab };
    return { mode: 'section' as InspectorMode, siteTab: 'design', nav: 'sections' as NavTab };
  }, [wanted]);
  const [mode, setMode] = useState<InspectorMode>(initial.mode);
  const [navTab, setNavTab] = useState<NavTab>(initial.nav);
  const [workspace, setWorkspace] = useState<StudioWorkspace>(initial.workspace ?? 'design');
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  const [aiBusy, setAiBusy] = useState(false);
  useEffect(() => { setMode(initial.mode); setNavTab(initial.nav); if (initial.workspace) setWorkspace(initial.workspace); }, [initial]);
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

  // AI-assisted content (Optimize suggestions): one change set through the Studio AI planner, reviewed on the canvas and
  // approved in the AI panel like any other request. Nothing is applied or published here.
  const requestAi = useCallback(async (request: 'faq' | 'about') => {
    setAiBusy(true);
    try {
      const body = { prompt: t(`studio.opt.ai.${request}`), locale };
      const res = await session.call<{ changeSet: ChangeSetView; plan: StudioAiPlan }>(`/o/${orgId}/studio/ai/proposals`,
        { body, headers: { 'Idempotency-Key': newIdempotencyKey() } });
      const after = await session.call<PublicSite>(`/o/${orgId}/studio/website/preview/change-sets/${res.changeSet.id}`).catch(() => null);
      setProposal({ changeSet: res.changeSet, plan: res.plan, after });
      setCompare('after');
      setWorkspace('design');
      setMode('ai');
      toast.show({ message: t('studio.opt.suggest.ready'), tone: 'ok' });
    } catch (e) {
      toast.show({ message: (e as Error).message, tone: 'danger' });
    } finally {
      setAiBusy(false);
    }
  }, [t, locale, session, orgId, toast]);

  const fix = useCallback((f: AuditFix) => {
    if (f.kind === 'section') { setWorkspace('design'); select(f.id); setMode('section'); return; }
    if (f.kind === 'ai') { if (!aiBusy) void requestAi(f.request); return; }
    if (f.kind === 'publish') { void publish(); return; }
    if (f.kind === 'addSection') {
      const ref = `new:${crypto.randomUUID()}`;
      void edit(addEntry(t('studio.ws.h.add', { kind: t(`studio.kind.${f.section}`) }), ref, { kind: f.section, content: {}, isVisible: true })).then((ok) => {
        if (ok) { setWorkspace('design'); select(history.idOf(ref)); setMode('section'); }
      });
    }
  }, [select, requestAi, aiBusy, publish, edit, history, t]);

  if (site.error) return <div className="card"><Notice tone="danger">{site.error.message}</Notice><button className="btn mbs-12" onClick={() => void site.reload()}>{t('action.retry')}</button></div>;
  if (!site.data) return <div className="card"><Skeleton lines={6} /></div>;
  const w = site.data.website;
  const studio: Studio = {
    orgId, state: site.data, preview, canWrite, canPublish, selected, select, edit, history, refresh, setDirty, reloadPreview: loadPreview, openOptimize: () => { setWorkspace('optimize'); setFocus(false); }, device, canvasLocale,
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
      <div className="ws-studio" data-focus={focus || undefined} data-workspace={workspace} data-zoom={zoom}>
        <WorkspacePage
          labels={{ toolbar: t('studio.ws.toolbar'), start: workspace === 'optimize' ? t('studio.opt.title') : t('studio.ws.navigator'), main: t('studio.ws.canvas'), end: t('studio.ws.inspector') }}
          toolbar={<StudioToolbar studio={studio} save={dirty && save === 'saved' ? 'unsaved' : save} onDevice={setDevice} onLocale={setCanvasLocale}
            onUndo={() => void step('undo')} onRedo={() => void step('redo')} focus={focus} onFocus={setFocus} onHistory={() => setHistoryOpen(true)}
            workspace={workspace} onWorkspace={(v) => { setWorkspace(v); setFocus(false); }} zoom={zoom} onZoom={setZoom} />}
          start={focus ? undefined : workspace === 'optimize'
            ? <OptimizeWorkspace studio={studio} onFix={fix} initialTab={initial.area ?? 'seo'} />
            : <Navigator studio={studio} tab={navTab} onTab={setNavTab} />}
          end={focus || workspace === 'optimize' ? undefined : <Inspector studio={studio} mode={mode} onMode={setMode} initialSiteTab={initial.siteTab} />}>
          {previewError ? <div className="ws-pane-pad"><Notice tone="danger">{previewError}</Notice><button type="button" className="btn btn-sm mbs-12" onClick={() => void loadPreview()}>{t('action.retry')}</button></div>
            : !shown ? <div className="ws-pane-pad"><Skeleton lines={8} /></div>
            : <Canvas site={shown} locale={canvasLocale} device={device} selected={selected} onSelect={select} zoom={zoom}
              compare={proposal ? compare : null} label={t('studio.ws.canvasFrame')} />}
        </WorkspacePage>
      </div>
      {historyOpen && <HistorySheet orgId={orgId} canWrite={canWrite} current={w.publishedRevision} open={historyOpen} onClose={() => setHistoryOpen(false)}
        onRestored={() => void refresh({ clearHistory: true })} />}
    </>
  );
}
