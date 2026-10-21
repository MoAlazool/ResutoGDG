'use client';
import { INTL_LOCALE } from '@resuto/contracts';
import Link from 'next/link';
import type { AdminOperations } from '@resuto/contracts';
import { useState } from 'react';
import { Badge, Card, DataTable, EmptyState, Notice, PageHeader, Skeleton, Stat, usePrompt } from '@resuto/ui';
import { useSession } from '@/lib/session';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useApi } from '@/lib/use-api';
import { useAdmin } from '../AdminShell';

/** Lets wide tables scroll inside the page instead of widening it on phones. */
const FIT = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' } as const;


export default function AdminOperationsPage() {
  const { locale, t } = useT();
  const { s, role } = useAdmin();
  const { call } = useSession();
  const ops = useApi<AdminOperations>('/admin/operations', { pollMs: 30_000 });
  const [prompt, promptDialog] = usePrompt(locale);
  const [replaying, setReplaying] = useState<string | null>(null);
  const [flash, setFlash] = useState<{ tone: 'ok' | 'danger'; text: string } | null>(null);
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
    } catch (e) { setFlash({ tone: 'danger', text: (e as Error).message }); } finally { setReplaying(null); }
  };
  if (ops.error) return <Notice tone="danger">{s.loadError} <button className="btn btn-sm" onClick={() => void ops.reload()}>{s.retry}</button></Notice>;
  if (!ops.data) return <Card><Skeleton lines={8} /></Card>;
  const d = ops.data;
  const tenant = (id: string | null) => (id ? <Link href={`/admin/tenants/${id}`}>{id.slice(0, 8)}</Link> : '—');

  return (
    <div style={FIT}>
      {promptDialog}
      <PageHeader title={s.opsTitle} subtitle={dateTime(d.generatedAt, locale)} actions={<button className="btn btn-sm" onClick={() => void ops.reload()}>{s.refresh}</button>} />
      <div className="grid grid-4" style={{ marginBlockEnd: 16 }}>
        <Stat label={`${s.outbox} · ${s.unpublished}`} value={d.outbox.unpublished} hint={d.outbox.oldestUnpublishedAt ? `${s.oldest}: ${dateTime(d.outbox.oldestUnpublishedAt, locale)} · ${s.retrying}: ${d.outbox.retrying}` : undefined}
          tone={d.outbox.retrying ? 'warn' : undefined} />
        <div><Stat label={`${s.handlers} · ${s.failed} / ${s.dead} / ${t('ops.admin.stuck')}`} value={`${d.eventHandlings.failed} / ${d.eventHandlings.dead} / ${d.eventHandlings.stuck ?? 0}`}
          tone={d.eventHandlings.dead || d.eventHandlings.stuck ? 'danger' : d.eventHandlings.failed ? 'warn' : 'ok'}
          hint={d.eventHandlings.failed + d.eventHandlings.dead + (d.eventHandlings.stuck ?? 0) === 0 ? s.allGood : d.eventHandlings.stuck ? t('ops.admin.stuckHint') : undefined} /></div>
        <div><Stat label={`${s.webhooks} · ${s.failed} / ${s.rejected}`} value={`${d.webhooks.failed} / ${d.webhooks.rejected}`} tone={d.webhooks.failed ? 'warn' : undefined} /></div>
        <div><Stat label={s.jobs} value={d.jobs.filter((j) => j.status === 'failed').length} hint={`${s.failed} · ${d.jobs.length}`} tone={d.jobs.some((j) => j.status === 'failed') ? 'danger' : 'ok'} /></div>
      </div>
      {flash && <div style={{ marginBlockEnd: 12 }}><Notice tone={flash.tone}>{flash.text}</Notice></div>}
      <Card title={`${s.handlers} — ${s.failed} / ${s.dead} / ${t('ops.admin.stuck')}`}>
        {d.eventHandlings.recent.length ? <DataTable rows={d.eventHandlings.recent} rowKey={(r) => `${r.eventId}:${r.handler}`} columns={[
          { key: 'h', header: s.handlers, render: (r) => <code>{r.handler}</code> },
          { key: 'e', header: '', render: (r) => r.eventType },
          { key: 's', header: s.status, render: (r) => <Badge tone={r.status === 'dead' || r.status === 'running' ? 'danger' : 'warn'}>{r.status === 'running' ? t('ops.admin.stuck') : r.status} · <span className="num">{r.attempts}</span></Badge> },
          { key: 't', header: s.tenants, render: (r) => tenant(r.orgId) },
          { key: 'x', header: '', render: (r) => <span className="fine">{r.lastError}</span> },
          { key: 'u', header: '', render: (r) => <span className="num">{dateTime(r.updatedAt, locale)}</span> },
          ...(canReplay ? [{ key: 'r', header: '', align: 'end' as const, render: (r: AdminOperations['eventHandlings']['recent'][number]) => (
            <button type="button" className="btn btn-sm" disabled={replaying !== null} aria-busy={replaying === `${r.eventId}:${r.handler}` || undefined}
              onClick={() => void replay(r.eventId, r.handler)}>{t('ops.admin.replay')}</button>) }] : []),
        ]} /> : <EmptyState title={s.allGood} />}
        {!canReplay && d.eventHandlings.recent.length > 0 && <p className="fine">{t('ops.admin.replayRole')}</p>}
      </Card>
      <Card title={`${s.webhooks} — ${s.failed} / ${s.rejected}`}>
        {d.webhooks.recent.length ? <DataTable rows={d.webhooks.recent} rowKey={(r) => r.id} columns={[
          { key: 'p', header: s.webhooks, render: (r) => r.provider },
          { key: 's', header: s.status, render: (r) => <Badge tone={r.status === 'rejected' ? 'danger' : 'warn'}>{r.status} · {r.attempts}</Badge> },
          { key: 't', header: s.tenants, render: (r) => tenant(r.orgId) },
          { key: 'x', header: '', render: (r) => <span className="fine">{r.error}</span> },
          { key: 'u', header: '', render: (r) => <span className="num">{dateTime(r.receivedAt, locale)}</span> },
        ]} /> : <EmptyState title={s.allGood} />}
      </Card>
      <div className="grid grid-2" style={{ marginBlockStart: 16 }}>
        <Card title={s.jobs}>
          {d.jobs.length ? <DataTable rows={d.jobs} rowKey={(j) => String(j.id)} columns={[
            { key: 'j', header: s.jobs, render: (j) => <code>{j.job}</code> },
            { key: 's', header: s.status, render: (j) => <Badge tone={j.status === 'succeeded' ? 'ok' : j.status === 'failed' ? 'danger' : 'info'}>{j.status}</Badge> },
            { key: 't', header: '', render: (j) => <span className="num">{dateTime(j.startedAt, locale)}</span> },
            { key: 'e', header: '', render: (j) => <span className="fine">{j.error ?? JSON.stringify(j.stats)}</span> },
          ]} /> : <EmptyState title={s.none} />}
        </Card>
        <Card title={s.usage}>
          {d.usage30d.length ? <DataTable rows={d.usage30d} rowKey={(u) => u.metric} columns={[
            { key: 'm', header: s.usage, render: (u) => u.metric },
            { key: 'q', header: '', align: 'end', render: (u) => <span className="num">{u.quantity.toLocaleString(locale === 'ar' ? INTL_LOCALE.ar : 'en')}</span> },
            { key: 't', header: '', align: 'end', render: (u) => <span className="fine">{u.tenants} {s.tenantsCol}</span> },
          ]} /> : <EmptyState title={s.none} />}
        </Card>
      </div>
    </div>
  );
}
