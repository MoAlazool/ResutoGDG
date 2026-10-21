'use client';
import { useState } from 'react';
import { Badge, Card, EmptyState, Notice, Skeleton, Tabs, TextareaField, useAction } from '@resuto/ui';
import { ApiRequestError } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';
import { ApprovalStatusBadge, CopyButton, LoadState, McpPage } from '../_components/shared';

interface Approval {
  id: string; tool: string; toolTitle: string; toolTitleAr: string; status: string; summary: string; input: Record<string, unknown>;
  client: { id: string; name: string; keyPrefix: string; actingRole: string };
  requestedAt: string; expiresAt: string; decidedBy: string | null; decidedAt: string | null; executedAt: string | null;
  decisionNote: string | null; result: Record<string, unknown> | null; error: string | null; invalidatedReason?: string | null;
}
interface ApprovalDetail extends Approval {
  preview: { summary: string; changes: Array<{ label: string; before: string | null; after: string }>; facts: Array<{ label: string; value: string }> } | null;
  previewError: string | null;
  /** Digest of exactly what is shown; sent with the approval so a newer state cannot be approved from this screen. */
  digest: string | null;
  changedSinceRequest: boolean;
}

const FILTERS = ['pending', 'executed', 'rejected', 'expired', 'failed', 'invalidated', 'all'] as const;
type Filter = (typeof FILTERS)[number];

export default function McpApprovalsPage() {
  const { t } = useT();
  const { org } = useOrg();
  const [filter, setFilter] = useState<Filter>('pending');
  const list = useApi<{ items: Approval[] }>(`/o/${org.id}/mcp/approvals?status=${filter}`, { pollMs: filter === 'pending' ? 15_000 : undefined });
  // Decisions stay visible here after the request leaves the "waiting" list (a payment URL is shown only once).
  const [recent, setRecent] = useState<Decision[]>([]);

  return (
    <McpPage tab="approvals" permission="mcp:approve">
      <Tabs tabs={FILTERS.map((k) => ({ key: k, label: t(`mcp.approvals.filter.${k}`) }))} value={filter} onChange={setFilter} />
      {recent.map((d) => (
        <Notice key={d.id} tone={d.tone}>
          <div className="stack" style={{ gap: 6 }}>
            <div className="spread"><strong dir="auto">{d.title}</strong>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRecent((r) => r.filter((x) => x.id !== d.id))}>{t('action.close')}</button></div>
            <span>{d.text}</span>
            {d.url && (
              <div className="row"><span className="fine">{t('mcp.approvals.payUrl')}</span>
                <code dir="ltr" style={{ wordBreak: 'break-all' }}>{d.url}</code><CopyButton text={d.url} /></div>
            )}
          </div>
        </Notice>
      ))}
      <LoadState loading={list.loading && !list.data} error={list.error} retry={list.reload}>
        {!list.data?.items.length ? (
          <Card><EmptyState title={t('mcp.approvals.empty.title')}>{t('mcp.approvals.empty.body')}</EmptyState></Card>
        ) : (
          <div className="stack">
            {list.data.items.map((a) => <ApprovalCard key={a.id} approval={a}
              onDecided={async (d) => { setRecent((r) => [d, ...r.filter((x) => x.id !== d.id)]); await list.reload(); }} />)}
          </div>
        )}
      </LoadState>
    </McpPage>
  );
}

interface Decision { id: string; title: string; tone: 'ok' | 'danger'; text: string; url?: string }

function ApprovalCard({ approval: a, onDecided }: { approval: Approval; onDecided: (d: Decision) => Promise<void> }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const session = useSession();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const detail = useApi<ApprovalDetail>(open ? `/o/${org.id}/mcp/approvals/${a.id}` : null);
  const fmt = (iso: string | null) => dateTime(iso, locale, org.timezone);

  const decide = useAction(async (action: 'approve' | 'reject') => {
    let res: Approval;
    try {
      res = await session.call<Approval>(`/o/${org.id}/mcp/approvals/${a.id}/${action}`, {
        body: { note: note.trim() || null, ...(action === 'approve' && detail.data?.digest ? { previewDigest: detail.data.digest } : {}) },
      });
    } catch (e) {
      // Closed because the data or the connection changed (FT-17): show why and refresh the queue; a changed screen reloads.
      if (e instanceof ApiRequestError && e.code === 'approval_invalidated') {
        await onDecided({ id: a.id, title: a.summary, tone: 'danger', text: t('mcp.approvals.invalidatedNow', { reason: e.message }) });
        return;
      }
      if (e instanceof ApiRequestError && e.code === 'approval_changed') await detail.reload();
      throw e;
    }
    const title = a.summary;
    if (action === 'reject') await onDecided({ id: a.id, title, tone: 'ok', text: t('mcp.approvals.rejectedOk') });
    else if (res.status === 'executed') {
      const url = typeof res.result?.url === 'string' ? res.result.url : undefined;
      await onDecided({ id: a.id, title, tone: 'ok', text: t('mcp.approvals.executedOk'), url });
    } else await onDecided({ id: a.id, title, tone: 'danger', text: t('mcp.approvals.failed', { error: res.error ?? '' }) });
  });

  const pending = a.status === 'pending';
  return (
    <section className="card" aria-labelledby={`appr-${a.id}`}>
      <div className="spread">
        <div className="row" style={{ gap: 8 }}>
          <Badge tone="warn">{t('mcp.badge.sensitive')}</Badge>
          <strong id={`appr-${a.id}`}>{locale === 'ar' ? a.toolTitleAr : a.toolTitle}</strong>
          <ApprovalStatusBadge status={a.status} />
        </div>
        <button type="button" className="btn btn-sm btn-ghost" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? t('mcp.approvals.hide') : t('mcp.approvals.review')}
        </button>
      </div>
      <p dir="auto" style={{ margin: '10px 0 6px', fontSize: 15 }}>{a.summary}</p>
      <div className="fine">
        {t('mcp.approvals.requestedBy', { client: a.client.name, role: t(`mcp.role.${a.client.actingRole}`) })}
        {' · '}{t('mcp.approvals.requestedAt', { date: fmt(a.requestedAt) })}
        {pending && <> · {t('mcp.approvals.expires', { date: fmt(a.expiresAt) })}</>}
        {a.decidedAt && <> · {t('mcp.approvals.decided', { date: fmt(a.decidedAt) })}</>}
      </div>
      {a.decisionNote && <p className="fine">{t('mcp.approvals.noteLabel', { note: a.decisionNote })}</p>}
      {a.error && <Notice tone="danger">{a.error}</Notice>}

      {open && (
        <div className="stack" style={{ marginBlockStart: 14 }}>
          {detail.loading && <Skeleton lines={3} />}
          {detail.error && <Notice tone="danger">{t('mcp.error.load', { message: detail.error.message })}</Notice>}
          {pending && detail.data?.changedSinceRequest && <Notice tone="warn">{t('mcp.approvals.changedSinceRequest')}</Notice>}
          {detail.data?.previewError && <Notice tone="warn">{t('mcp.approvals.previewError', { error: detail.data.previewError })}</Notice>}
          {detail.data?.preview && (
            <>
              <div>
                <h4 style={{ margin: '0 0 8px' }}>{t('mcp.approvals.change')}</h4>
                <div className="table-wrap">
                  <table className="data">
                    <thead><tr><th scope="col" /><th scope="col">{t('mcp.approvals.before')}</th><th scope="col">{t('mcp.approvals.after')}</th></tr></thead>
                    <tbody>
                      {detail.data.preview.changes.map((c) => (
                        <tr key={c.label}>
                          <th scope="row" style={{ textAlign: 'start', fontWeight: 650 }} dir="auto">{c.label}</th>
                          <td dir="auto"><del style={{ color: 'var(--danger)' }}>{c.before ?? '—'}</del></td>
                          <td dir="auto"><ins style={{ color: 'var(--ok)', textDecoration: 'none', fontWeight: 650 }}>{c.after}</ins></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {!!detail.data.preview.facts.length && (
                <div>
                  <h4 style={{ margin: '0 0 8px' }}>{t('mcp.approvals.details')}</h4>
                  <dl style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '6px 16px', margin: 0 }}>
                    {detail.data.preview.facts.map((f) => (
                      <div key={f.label} style={{ display: 'contents' }}><dt className="muted" dir="auto">{f.label}</dt><dd style={{ margin: 0 }} dir="auto">{f.value}</dd></div>
                    ))}
                  </dl>
                </div>
              )}
            </>
          )}
          <details>
            <summary className="fine" style={{ cursor: 'pointer' }}>{t('mcp.approvals.input')}</summary>
            <pre dir="ltr" style={{ background: '#fbfbf8', border: '1px solid var(--line-soft)', borderRadius: 10, padding: 12, fontSize: 12, overflow: 'auto' }}>
              {JSON.stringify(a.input, null, 2)}
            </pre>
          </details>
          {a.result && (
            <details>
              <summary className="fine" style={{ cursor: 'pointer' }}>{t('mcp.approvals.result')}</summary>
              <pre dir="ltr" style={{ background: '#fbfbf8', border: '1px solid var(--line-soft)', borderRadius: 10, padding: 12, fontSize: 12, overflow: 'auto' }}>
                {JSON.stringify(a.result, null, 2)}
              </pre>
            </details>
          )}
          {pending && (
            <>
              <TextareaField label={t('mcp.approvals.note')} value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
              <p className="fine" style={{ margin: 0 }}>{t('mcp.approvals.approveHint')}</p>
              {decide.error && <Notice tone="danger">{decide.error}</Notice>}
              <div className="row" style={{ justifyContent: 'flex-end' }}>
                <button type="button" className="btn btn-ghost" disabled={decide.pending} onClick={() => void decide.run('reject')}>{t('mcp.approvals.reject')}</button>
                <button type="button" className="btn btn-primary" disabled={decide.pending || !detail.data} onClick={() => void decide.run('approve')}>{t('mcp.approvals.approve')}</button>
              </div>
            </>
          )}
        </div>
      )}
    </section>
  );
}
