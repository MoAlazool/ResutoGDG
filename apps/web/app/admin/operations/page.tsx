'use client';
import Link from 'next/link';
import { useState } from 'react';
import { INTL_LOCALE, type AdminOperations } from '@resuto/contracts';
import { Badge, DataTableV2, EmptyState, ErrorState, Freshness, ListPage, Notice, Panel, StatV2, usePrompt, type ColumnV2 } from '@resuto/ui';
import { AreaSkeleton } from '@/components/shell/AreaSkeleton';
import { useSession } from '@/lib/session';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { AdminIcon } from '../admin-icons';
import { useAdmin } from '../AdminShell';
import { opsTiles, type OpsTile } from '../console';
import { fill } from '../strings';
import { opsStatusLabel, replayFailure } from './replay';

type Handling = AdminOperations['eventHandlings']['recent'][number];
type Webhook = AdminOperations['webhooks']['recent'][number];
type Job = AdminOperations['jobs'][number];
type Usage = AdminOperations['usage30d'][number];

/**
 * Operations (21-ADMIN): the platform's delivery health. Four StatV2 tiles marked Live (counted from the platform's
 * own tables when the page loaded, polled every 30 s), then the failing handler runs (superadmins replay them with a
 * recorded reason), failing webhooks, scheduled jobs and 30-day usage.
 */
export default function AdminOperationsPage() {
  const { locale, t } = useT();
  const { s, role } = useAdmin();
  const { call } = useSession();
  const ops = useApi<AdminOperations>('/admin/operations', { pollMs: 30_000 });
  const [prompt, promptDialog] = usePrompt(locale);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'warn' | 'danger'; text: string } | null>(null);
  const canReplay = role === 'superadmin';
  /** Replays one dead, failed or stuck handler run (superadmin; the server audits it with the reason). */
  const replay = async (eventId: string, handler: string) => {
    if (replaying) return;
    const reason = await prompt({ title: t('ops.admin.replayTitle', { handler }), label: t('ops.admin.reason'), minLength: 3, maxLength: 500, multiline: true, confirmLabel: t('ops.admin.replay') });
    if (!reason) return;
    setReplaying(`${eventId}:${handler}`); setFlash(null);
    try {
      await call(`/admin/operations/handlings/${eventId}/${encodeURIComponent(handler)}/replay`, { body: { reason } });
      setFlash({ tone: 'ok', text: t('ops.admin.replayed', { handler }) });
      await ops.reload();
    } catch (e) { setFlash(replayFailure(e, t, locale)); } finally { setReplaying(null); }
  };

  const header = {
    title: s.opsTitle,
    subtitle: s.opsSub,
    actions: (
      <div className="admin-ops-head">
        <Freshness locale={locale} refreshing={ops.refreshing} updatedAt={ops.updatedAt} />
        <button type="button" className="btn btn-sm" onClick={() => void ops.reload()} disabled={ops.refreshing} aria-busy={ops.refreshing || undefined}>
          <AdminIcon name="refresh" size={16} /> {s.refresh}
        </button>
      </div>
    ),
  };
  if (ops.error && !ops.data) {
    return <ListPage header={header}><ErrorState locale={locale} error={{ status: ops.error.status, code: ops.error.code, message: ops.error.message, requestId: ops.error.requestId }} onRetry={ops.reload} /></ListPage>;
  }
  if (!ops.data) return <AreaSkeleton template="dashboard" />;
  const d = ops.data;
  const tenant = (id: string | null) => (id ? <Link href={`/admin/tenants/${id}`} className="admin-code" dir="ltr">{id.slice(0, 8)}</Link> : '—');
  const nf = new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en');

  const tiles: Record<OpsTile['key'], { label: string; hint?: string }> = {
    outbox: { label: s.statOutbox, hint: d.outbox.oldestUnpublishedAt ? fill(s.outboxHint, { time: dateTime(d.outbox.oldestUnpublishedAt, locale), n: d.outbox.retrying }) : s.allGood },
    handlers: { label: s.statHandlers, hint: fill(s.handlersHint, { failed: d.eventHandlings.failed, dead: d.eventHandlings.dead, stuck: d.eventHandlings.stuck ?? 0 }) },
    webhooks: { label: s.statWebhooks, hint: fill(s.webhooksHint, { failed: d.webhooks.failed, rejected: d.webhooks.rejected }) },
    jobs: { label: s.statJobs, hint: fill(s.jobsHint, { n: d.jobs.length }) },
  };

  const handlerCols: ColumnV2<Handling>[] = [
    { key: 'h', header: s.handlers, rowHeader: true, render: (r) => <span className="admin-code" dir="ltr">{r.handler}</span> },
    { key: 'e', header: s.event, render: (r) => <span className="admin-code" dir="ltr">{r.eventType}</span> },
    { key: 's', header: s.status, render: (r) => <Badge tone={r.status === 'dead' || r.status === 'running' ? 'danger' : 'warn'}>{opsStatusLabel(r.status, s, t, 'handler')} · <bdi className="num">{r.attempts}</bdi></Badge> },
    { key: 't', header: s.tenants, render: (r) => tenant(r.orgId) },
    { key: 'x', header: s.error, render: (r) => <span className="admin-error-text" dir="auto">{r.lastError}</span> },
    { key: 'u', header: s.updated, sort: (a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt), render: (r) => <span className="num">{dateTime(r.updatedAt, locale)}</span> },
    ...(canReplay ? [{ key: 'r', header: t('ops.admin.replay'), align: 'end' as const, render: (r: Handling) => (
      <button type="button" className="btn btn-sm" disabled={replaying !== null} aria-busy={replaying === `${r.eventId}:${r.handler}` || undefined}
        onClick={() => void replay(r.eventId, r.handler)}>{t('ops.admin.replay')}</button>) }] : []),
  ];
  const webhookCols: ColumnV2<Webhook>[] = [
    { key: 'p', header: s.provider, rowHeader: true, render: (r) => <span className="admin-code" dir="ltr">{r.provider}</span> },
    { key: 's', header: s.status, render: (r) => <Badge tone={r.status === 'rejected' ? 'danger' : 'warn'}>{opsStatusLabel(r.status, s, t, 'webhook')} · <bdi className="num">{r.attempts}</bdi></Badge> },
    { key: 't', header: s.tenants, render: (r) => tenant(r.orgId) },
    { key: 'x', header: s.error, render: (r) => <span className="admin-error-text" dir="auto">{r.error}</span> },
    { key: 'u', header: s.received, sort: (a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt), render: (r) => <span className="num">{dateTime(r.receivedAt, locale)}</span> },
  ];
  const jobCols: ColumnV2<Job>[] = [
    { key: 'j', header: s.jobs, rowHeader: true, render: (j) => <span className="admin-code" dir="ltr">{j.job}</span> },
    { key: 's', header: s.status, render: (j) => <Badge tone={j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'danger' : 'info'}>{opsStatusLabel(j.status, s, t, 'job')}</Badge> },
    { key: 't', header: s.started, sort: (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt), render: (j) => <span className="num">{dateTime(j.startedAt, locale)}</span> },
    { key: 'e', header: s.result, render: (j) => (j.error
      ? <span className="admin-error-text" dir="auto">{j.error}</span>
      : <span className="admin-code fine" dir="ltr">{JSON.stringify(j.stats)}</span>) },
  ];
  const usageCols: ColumnV2<Usage>[] = [
    { key: 'm', header: s.metric, rowHeader: true, sort: (a, b) => a.metric.localeCompare(b.metric), render: (u) => <span className="admin-code" dir="ltr">{u.metric}</span> },
    { key: 'q', header: s.quantity, align: 'end', sort: (a, b) => a.quantity - b.quantity, render: (u) => <span className="num">{nf.format(u.quantity)}</span> },
    { key: 't', header: s.tenants, align: 'end', sort: (a, b) => a.tenants - b.tenants, render: (u) => <span className="num">{nf.format(u.tenants)}</span> },
  ];

  return (
    <ListPage header={{ ...header, subtitle: <>{s.opsSub} <span className="num">{fill(s.generatedAt, { time: dateTime(d.generatedAt, locale) })}</span></> }}
      filters={
        <div className="admin-stack">
          <div className="rui-stat-grid" role="group" aria-label={s.opsTitle}>
            {opsTiles(d).map((tile) => (
              <div key={tile.key} className="admin-tile" data-tone={tile.tone} data-tile={tile.key}>
                <StatV2 locale={locale} label={tiles[tile.key].label} value={tile.value} provenance="live" hint={tiles[tile.key].hint} />
              </div>
            ))}
          </div>
          <p className="admin-note">{s.provenanceNote}</p>
        </div>
      }>
      {promptDialog}
      <div className="admin-stack">
        {flash && <Notice tone={flash.tone}>{flash.text}</Notice>}
        <Panel title={`${s.handlers} — ${s.failed} / ${s.dead} / ${t('ops.admin.stuck')}`} note={!canReplay && d.eventHandlings.recent.length > 0 ? t('ops.admin.replayRole') : undefined}>
          <DataTableV2 label={s.handlers} locale={locale} rows={d.eventHandlings.recent} rowKey={(r) => `${r.eventId}:${r.handler}`} columns={handlerCols}
            empty={<EmptyState title={s.allGood} />} />
        </Panel>
        <Panel title={`${s.webhooks} — ${s.failed} / ${s.rejected}`}>
          <DataTableV2 label={s.webhooks} locale={locale} rows={d.webhooks.recent} rowKey={(r) => r.id} columns={webhookCols} empty={<EmptyState title={s.allGood} />} />
        </Panel>
        <div className="admin-panels">
          <Panel title={s.jobs}>
            <DataTableV2 label={s.jobs} locale={locale} rows={d.jobs} rowKey={(j) => String(j.id)} columns={jobCols} empty={<EmptyState title={s.none} />} />
          </Panel>
          <Panel title={s.usage}>
            <DataTableV2 label={s.usage} locale={locale} rows={d.usage30d} rowKey={(u) => u.metric} columns={usageCols} empty={<EmptyState title={s.none} />} />
          </Panel>
        </div>
      </div>
    </ListPage>
  );
}
