'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import type { MenuExtractionJob, StudioAiCapabilities } from '@resuto/contracts';
import { Badge, EmptyState, Notice, PageHeader, SkeletonTable, Tabs, TextareaField, ToastProvider, useToast } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { dateTime, isolate } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { ReviewPanel, modeLabel, statusTone } from './_components/ReviewPanel';
import './_components/menu-import.css';

export default function MenuImportPage() {
  const { t } = useT();
  return (
    <ModuleGate module="core" permission="menu:write">
      <ToastProvider closeLabel={t('action.close')}>
        <Suspense fallback={<div className="card"><SkeletonTable rows={4} cols={4} /></div>}>
          <MenuImport />
        </Suspense>
      </ToastProvider>
    </ModuleGate>
  );
}

type Source = 'text' | 'csv' | 'file';

function MenuImport() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const router = useRouter();
  const search = useSearchParams();
  const selected = search.get('job');
  const caps = useApi<StudioAiCapabilities>(`/o/${org.id}/studio-ai/capabilities`);
  const jobs = useApi<{ items: MenuExtractionJob[] }>(`/o/${org.id}/menu-import/jobs`);
  const open = (id: string | null) => router.replace(id ? `/dashboard/${org.id}/menu-import?job=${id}` : `/dashboard/${org.id}/menu-import`, { scroll: false });
  const byok = caps.data?.byok;

  return (
    <>
      {/* 21-MENU: reached from the menu workspace's Import action (assisted extraction keeps its own review step here). */}
      <PageHeader overline={t('studio.ai.import.overline')} title={t('studio.ai.import.title')} subtitle={t('studio.ai.import.subtitle')}
        actions={<Link className="btn" href={`/dashboard/${org.id}/menu`}>{t('menu.ws.backToMenu')}</Link>} />
      <div className="mi-layout" data-open={selected ? 'true' : undefined}>
        <div className="stack">
          {caps.data && (byok?.configured
            ? <Notice tone="ok">{t('studio.ai.byok.on', { model: isolate(byok.model ?? '') })}</Notice>
            : <Notice tone="info"><span>{t('studio.ai.byok.off')}</span>{' '}<Link className="btn btn-sm" href={`/dashboard/${org.id}/integrations`}>{t('studio.ai.byok.connect')}</Link></Notice>)}
          <SourcePanel fileEnabled={!!caps.data?.menuExtraction.image} onCreated={async (job) => { await jobs.reload(); open(job.id); }} />
          <section className="card">
            <h2 className="mi-h2">{t('studio.ai.recent')}</h2>
            {!jobs.data ? <SkeletonTable rows={3} cols={3} /> : jobs.data.items.length === 0 ? <p className="fine">{t('studio.ai.recentEmpty')}</p> : (
              <ul className="mi-jobs">
                {jobs.data.items.map((j) => (
                  <li key={j.id} aria-current={j.id === selected ? 'true' : undefined}>
                    <button type="button" className="mi-job" onClick={() => open(j.id)}>
                      <span className="mi-job-name"><bdi>{j.sourceName ?? t(`studio.ai.src.${j.sourceKind === 'image' || j.sourceKind === 'pdf' ? 'file' : j.sourceKind}`)}</bdi></span>
                      <span className="row mi-job-meta">
                        <Badge tone={statusTone(j.status)}>{t(`studio.ai.status.${j.status}`)}</Badge>
                        <span className="fine">{modeLabel(t, j)}</span>
                        <span className="fine">{t('studio.ai.rows', { n: j.summary.total })} · {dateTime(j.createdAt, locale)}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="fine">{t('studio.ai.floor.deferred')}</p>
        </div>
        <div className="mi-review">
          {selected ? <ReviewPanel key={selected} jobId={selected} onChanged={() => jobs.reload()} onClose={() => open(null)} />
            : <div className="card"><EmptyState title={t('studio.ai.review.untitled')}>{t('studio.ai.import.subtitle')}</EmptyState></div>}
        </div>
      </div>
    </>
  );
}

function SourcePanel({ fileEnabled, onCreated }: { fileEnabled: boolean; onCreated: (job: MenuExtractionJob) => Promise<void> }) {
  const { t } = useT();
  const { org } = useOrg();
  const { call } = useSession();
  const toast = useToast();
  const [source, setSource] = useState<Source>('text');
  const [text, setText] = useState('');
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = source === 'text' ? !!text.trim() : source === 'csv' ? !!csv : !!file && fileEnabled;

  const read = async () => {
    if (busy || !ready) return;
    setBusy(true); setError(null);
    try {
      let job: MenuExtractionJob;
      if (source === 'file') {
        const form = new FormData();
        form.append('file', file!);
        job = await call<MenuExtractionJob>(`/o/${org.id}/menu-import/jobs/file`, { body: form });
      } else {
        job = await call<MenuExtractionJob>(`/o/${org.id}/menu-import/jobs/text`, {
          body: source === 'text' ? { kind: 'text', text } : { kind: 'csv', text: csv!.text, name: csv!.name.slice(0, 120) },
        });
      }
      setText(''); setCsv(null); setFile(null);
      await onCreated(job);
    } catch (e) {
      setError((e as Error).message);
      toast.show({ message: (e as Error).message, tone: 'danger' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <Tabs tabs={[{ key: 'text', label: t('studio.ai.src.text') }, { key: 'csv', label: t('studio.ai.src.csv') }, { key: 'file', label: t('studio.ai.src.file') }]}
        value={source} onChange={(k) => { setSource(k); setError(null); }} label={t('studio.ai.import.title')} />
      <div className="stack mbs-12">
        {source === 'text' && <>
          <p className="fine">{t('studio.ai.src.textHint')}</p>
          <TextareaField label={t('studio.ai.src.textLabel')} value={text} onChange={(e) => setText(e.target.value)} rows={10} maxLength={200_000} dir="auto" />
        </>}
        {source === 'csv' && <>
          <p className="fine">{t('studio.ai.src.csvHint')}</p>
          <label className="field"><span>{t('studio.ai.src.csv')}</span>
            <input type="file" accept=".csv,text/csv" onChange={async (e) => { const f = e.target.files?.[0]; setCsv(f ? { name: f.name, text: await f.text() } : null); }} />
          </label>
        </>}
        {source === 'file' && <>
          <p className="fine">{t('studio.ai.src.fileHint')}</p>
          {!fileEnabled && <Notice tone="warn">{t('studio.ai.byok.off')}</Notice>}
          <label className="field"><span>{t('studio.ai.src.fileLabel')}</span>
            <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" disabled={!fileEnabled} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </>}
        {error && <Notice tone="danger">{error}</Notice>}
        <div><button type="button" className="btn btn-primary" disabled={!ready || busy} aria-busy={busy} onClick={() => void read()}>{busy ? t('studio.ai.src.reading') : t('studio.ai.src.read')}</button></div>
      </div>
    </section>
  );
}
