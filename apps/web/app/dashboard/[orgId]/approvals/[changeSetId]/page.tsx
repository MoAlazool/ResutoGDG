'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { MCP_TOOLS, type ChangeAuditEntry, type ChangeSetView, type McpToolName, type Page } from '@resuto/contracts';
import { Card, DetailPage, EmptyState, ErrorState, KeyValueList, Notice, Skeleton, TextareaField, useAction } from '@resuto/ui';
import { AuditTimeline, ChangeSetDiff, RequirementLine, SetStatusBadge } from '@/components/changes/ChangeSetDiff';
import { ApiRequestError } from '@/lib/api';
import { canDecide, canReject } from '@/lib/change-diff';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useSession } from '@/lib/session';
import { useApi } from '@/lib/use-api';

type Outcome = { tone: 'ok' | 'warn' | 'danger' | 'info'; text: string };

/**
 * One change set (21-MCP approvals inbox): the before/after of every op, effect status, who must approve (and whether
 * the owner must), the decision with a reason, and the audit timeline. Approve and reject step up to MFA for people
 * with an authenticator: the API answers 403 mfa_required and the session asks for the code (the existing step-up).
 */
export default function ChangeSetPage() {
  const { changeSetId } = useParams<{ changeSetId: string }>();
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const session = useSession();
  const path = `/o/${org.id}/change-sets/${changeSetId}`;
  const cs = useApi<ChangeSetView>(can('changes:read') ? path : null, { staleMs: 0 });
  const audit = useApi<Page<ChangeAuditEntry>>(can('changes:read') ? `${path}/audit?limit=100` : null, { staleMs: 0 });
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [needReason, setNeedReason] = useState(false);
  const fmt = (iso: string | null) => dateTime(iso, locale, org.timezone);

  const decide = useAction(async (action: 'approve' | 'reject') => {
    if (action === 'reject' && !reason.trim()) { setNeedReason(true); return; }
    setNeedReason(false);
    setOutcome(null);
    try {
      const next = await session.call<ChangeSetView>(`${path}/${action}`, {
        body: { note: reason.trim() || undefined, ...(action === 'approve' && cs.data?.previewDigest ? { previewDigest: cs.data.previewDigest } : {}) },
      });
      cs.setData(next);
      setOutcome(action === 'reject' ? { tone: 'ok', text: t('mcp.inbox.done.rejected') }
        : next.status === 'pending_approval' ? { tone: 'info', text: t('mcp.inbox.done.recorded') }
          : next.status === 'applied' ? { tone: 'ok', text: t('mcp.inbox.done.applied') }
            : { tone: 'warn', text: t('mcp.inbox.done.other', { status: t(`mcp.inbox.status.${next.status}`) }) });
      setReason('');
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'mfa_required') {
        setOutcome({ tone: 'info', text: t('mcp.inbox.mfaRequired') });
        return;
      }
      if (e instanceof ApiRequestError && ['change_set_invalidated', 'approval_invalidated', 'approval_changed', 'change_set_expired'].includes(e.code)) {
        setOutcome({ tone: 'warn', text: t('mcp.inbox.done.invalidated', { reason: e.message }) });
        await cs.reload();
        return;
      }
      throw e;
    } finally {
      void audit.reload();
    }
  });

  if (!can('changes:read')) return <div className="card"><EmptyState title={t('state.locked')}>{t('mcp.inbox.locked')}</EmptyState></div>;
  const c = cs.data;
  const me = { userId: session.me?.user.id ?? '', role: org.role };
  // Sensitive MCP requests (payment links, campaign sends, availability) are decided by people with mcp:approve too.
  const mcpRequest = !!c?.sourceTool && !!MCP_TOOLS[c.sourceTool as McpToolName]?.sensitive;
  const mayDecide = can('changes:approve') && (!mcpRequest || can('mcp:approve'));
  const verdict = c ? canDecide(c, me, mayDecide) : null;
  const rejectable = c ? canReject(c, me, mayDecide) : null;

  const facts = c && (
    <Card>
      <KeyValueList items={[
        { key: 'status', label: t('mcp.col.status'), value: <SetStatusBadge status={c.status} /> },
        { key: 'origin', label: t('mcp.inbox.source'), value: t(`mcp.inbox.origin.${c.origin}`) },
        ...(c.sourceTool ? [{ key: 'tool', label: t('mcp.col.tool'), value: <code dir="ltr">{c.sourceTool}</code> }] : []),
        ...(c.actor.mcpClientId && can('mcp:manage')
          ? [{ key: 'conn', label: t('mcp.col.client'), value: <Link href={`/dashboard/${org.id}/mcp/clients/${c.actor.mcpClientId}`}>{t('mcp.inbox.openConnection')}</Link> }] : []),
        { key: 'needs', label: t('mcp.inbox.approvers'), value: <RequirementLine cs={c} /> },
        { key: 'created', label: t('mcp.inbox.proposedAt'), value: fmt(c.createdAt) },
        ...(c.status === 'pending_approval' && c.expiresAt ? [{ key: 'exp', label: t('mcp.inbox.expiresAt'), value: fmt(c.expiresAt) }] : []),
        ...(c.decidedAt ? [{ key: 'dec', label: t('mcp.inbox.decidedAt'), value: fmt(c.decidedAt) }] : []),
        ...(c.decisionNote ? [{ key: 'note', label: t('mcp.inbox.reason'), value: <span dir="auto">{c.decisionNote}</span> }] : []),
      ]} />
      {(c.error || c.invalidatedReason) && <Notice tone="warn">{c.invalidatedReason ?? c.error}</Notice>}
    </Card>
  );

  // DetailPage: the changes and the decision in the main column; facts and the audit trail in the inspector.
  return (
    <DetailPage inspectorLabel={t('mcp.inbox.audit')}
      header={{ eyebrow: t('mcp.inbox.title'), title: c?.title ?? t('mcp.inbox.title'), subtitle: c?.summary ?? undefined,
        actions: <Link className="btn btn-ghost" href={`/dashboard/${org.id}/approvals`}>{t('mcp.inbox.back')}</Link> }}
      inspector={c ? <>
        {facts}
        <Card title={t('mcp.inbox.audit')}>
          {audit.loading && !audit.data ? <Skeleton lines={3} /> : <AuditTimeline rows={audit.data?.items ?? []} timezone={org.timezone} />}
        </Card>
      </> : undefined}>
      {cs.error ? <Card><ErrorState error={cs.error} onRetry={cs.reload} locale={locale} /></Card>
        : !c ? <Card><Skeleton lines={5} /></Card> : (
          <div className="stack gap-16">
            <Card title={t('mcp.inbox.changes')}>
              <ChangeSetDiff cs={c} />
            </Card>

            {outcome && <Notice tone={outcome.tone}>{outcome.text}</Notice>}
            {c.status === 'pending_approval' && (
              <Card title={t('mcp.inbox.decision')}>
                {verdict && !verdict.ok && rejectable && !rejectable.ok ? <p className="muted m-0">{t(`mcp.inbox.cannot.${verdict.reason}`)}</p> : (
                  <div className="cx-decide">
                    {verdict && !verdict.ok && <Notice tone="info">{t(`mcp.inbox.cannot.${verdict.reason}`)}</Notice>}
                    <TextareaField label={t('mcp.inbox.reason')} hint={t('mcp.inbox.reasonHint')} value={reason} maxLength={500} rows={2}
                      onChange={(e) => { setReason(e.target.value); setNeedReason(false); }} />
                    {needReason && <Notice tone="warn">{t('mcp.inbox.reasonRequired')}</Notice>}
                    <p className="fine m-0">{t('mcp.inbox.mfaHint')}</p>
                    {decide.error && <Notice tone="danger">{decide.error}</Notice>}
                    <div className="row justify-end">
                      <button type="button" className="btn btn-ghost" disabled={decide.pending} onClick={() => void decide.run('reject')}>{t('mcp.inbox.reject')}</button>
                      {verdict?.ok && (
                        <button type="button" className="btn btn-primary" disabled={decide.pending} onClick={() => void decide.run('approve')}>{t('mcp.inbox.approve')}</button>
                      )}
                    </div>
                  </div>
                )}
              </Card>
            )}
          </div>
        )}
    </DetailPage>
  );
}
