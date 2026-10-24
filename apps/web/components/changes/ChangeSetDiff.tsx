'use client';
// 21-MCP approvals inbox: one change set as the person deciding sees it. Presentational (props only), so the diff
// rendering is unit-tested in app/dashboard/[orgId]/mcp/new/wizard-steps.test.tsx.
import type { ChangeAuditEntry, ChangeSetSummary, ChangeSetView } from '@resuto/contracts';
import { Badge } from '@resuto/ui';
import { dateTime } from '@/lib/format';
import { diffRows, effectKey, OP_TONE, requirementOf, SET_TONE, timelineOf } from '@/lib/change-diff';
import { useT } from '@/lib/i18n/client';
import { actionLabel } from '@/lib/vocab';
import './changes.css';

export function SetStatusBadge({ status }: { status: ChangeSetSummary['status'] }) {
  const { t } = useT();
  return <Badge tone={SET_TONE[status] ?? 'neutral'}>{t(`mcp.inbox.status.${status}`)}</Badge>;
}

/** Who must still approve: the count, and the owner when the discount is above their threshold. */
export function RequirementLine({ cs }: { cs: Pick<ChangeSetView, 'policy' | 'decisions' | 'status'> }) {
  const { t } = useT();
  const r = requirementOf(cs);
  if (cs.policy.mode !== 'approval') return <span>{t('mcp.inbox.byPolicy')}</span>;
  return (
    <span className="row gap-6">
      <span>{t('mcp.inbox.approvedCount', { approved: r.approved, required: r.required })}</span>
      {r.ownerRequired && <Badge tone="warn">{t('mcp.inbox.ownerRequired')}</Badge>}
    </span>
  );
}

/** Every op with its before/after lines, status and (external actions) effect. */
export function ChangeSetDiff({ cs }: { cs: Pick<ChangeSetView, 'ops'> }) {
  const { t, locale } = useT();
  return (
    <div>
      {cs.ops.map((op) => {
        const rows = diffRows(op);
        const effect = effectKey(op);
        return (
          <section key={op.id} className="cx-op" aria-label={locale === 'ar' ? op.titleAr : op.title}>
            <div className="cx-op-head">
              <strong>{locale === 'ar' ? op.titleAr : op.title}</strong>
              <Badge tone={OP_TONE[op.status] ?? 'neutral'}>{t(`mcp.inbox.op.${op.status}`)}</Badge>
              {effect && <Badge tone={op.effect?.status === 'failed' || op.effect?.status === 'needs_attention' ? 'danger' : 'info'}>{t(effect)}</Badge>}
            </div>
            <p className="m-0" dir="auto">{op.summary}</p>
            {!!rows.length && (
              <div className="cx-wrap">
                <table className="cx-table">
                  <thead><tr><th scope="col">{t('mcp.inbox.field')}</th><th scope="col">{t('mcp.approvals.before')}</th><th scope="col">{t('mcp.inbox.after')}</th></tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={`${r.label}-${i}`}>
                        <th scope="row" dir="auto">{r.label}</th>
                        <td dir="auto">{r.before === null ? <span className="cx-same">{t('mcp.inbox.new')}</span>
                          : <span className={r.same ? 'cx-same' : 'cx-before'}>{r.before || '—'}</span>}</td>
                        <td dir="auto"><span className={r.same ? 'cx-same' : 'cx-after'}>{r.after || '—'}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {op.error && <p className="fine m-0" dir="auto">{t('mcp.inbox.opError', { error: op.error })}</p>}
            {op.effect?.lastError && <p className="fine m-0" dir="auto">{t('mcp.inbox.opError', { error: op.effect.lastError })}</p>}
          </section>
        );
      })}
    </div>
  );
}

/** The set's audit trail, oldest first (every transition and op, who did it and when). */
export function AuditTimeline({ rows, timezone }: { rows: readonly ChangeAuditEntry[]; timezone: string }) {
  const { t, locale } = useT();
  const items = timelineOf(rows);
  if (!items.length) return <p className="muted m-0">{t('mcp.inbox.auditEmpty')}</p>;
  return (
    <ol className="cx-timeline">
      {items.map((it) => (
        <li key={it.id}>
          <strong>{actionLabel(t, it.action) ?? it.action}</strong>
          <span className="fine">
            <time dateTime={it.at}>{dateTime(it.at, locale, timezone)}</time>
            {' · '}{t(`mcp.inbox.actor.${['user', 'mcp_client', 'system'].includes(it.actorType) ? it.actorType : 'system'}`)}
            {it.aal === 'aal2' && <> · {t('mcp.inbox.withMfa')}</>}
          </span>
          {it.note && <span className="fine" dir="auto">{it.note}</span>}
        </li>
      ))}
    </ol>
  );
}
