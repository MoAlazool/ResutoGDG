'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CHANGE_OPS, CHANGE_ORIGINS, type ChangeOpType, type ChangeOrigin, type ChangeSetSummary, type Page } from '@resuto/contracts';
import { Badge, Card, EmptyState, ErrorState, ListPage, SelectField, SkeletonCards, Tabs } from '@resuto/ui';
import { SetStatusBadge } from '@/components/changes/ChangeSetDiff';
import { INBOX_FILTERS, type InboxFilter } from '@/lib/change-diff';
import { dateTime } from '@/lib/format';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';

/**
 * The approvals inbox (21-MCP, plan §6.6): every change set waiting for a decision, whatever proposed it (an AI
 * assistant over MCP, Studio AI, the copilot or a team member). Each opens with its before/after diff and audit trail.
 */
export default function ApprovalsInboxPage() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const [filter, setFilter] = useState<InboxFilter>('open');
  const [origin, setOrigin] = useState<ChangeOrigin | ''>('');
  // Links from the MCP area open the inbox on AI requests (?origin=mcp).
  useEffect(() => {
    const o = new URLSearchParams(window.location.search).get('origin');
    if (o && (CHANGE_ORIGINS as readonly string[]).includes(o)) setOrigin(o as ChangeOrigin);
  }, []);
  const query = `status=${filter}${origin ? `&origin=${origin}` : ''}&limit=50`;
  const list = useApi<Page<ChangeSetSummary>>(can('changes:read') ? `/o/${org.id}/change-sets?${query}` : null, { pollMs: filter === 'open' ? 15_000 : undefined });
  const base = `/dashboard/${org.id}/approvals`;
  const opTitle = (type: ChangeOpType) => (locale === 'ar' ? CHANGE_OPS[type]?.titleAr : CHANGE_OPS[type]?.title) ?? type;

  if (!can('changes:read')) {
    return <div className="card"><EmptyState title={t('state.locked')}>{t('mcp.inbox.locked')}</EmptyState></div>;
  }
  return (
    <ListPage header={{ title: t('mcp.inbox.title'), subtitle: t('mcp.inbox.subtitle'),
      actions: can('mcp:manage') || can('mcp:approve') ? <Link className="btn btn-ghost" href={`/dashboard/${org.id}/mcp`}>{t('mcp.inbox.toMcp')}</Link> : undefined }}
      filters={<div className="spread">
        <Tabs label={t('mcp.inbox.title')} tabs={INBOX_FILTERS.map((k) => ({ key: k, label: t(`mcp.inbox.filter.${k}`) }))} value={filter} onChange={setFilter} />
        <SelectField label={t('mcp.inbox.source')} value={origin} onChange={(e) => setOrigin(e.target.value as ChangeOrigin | '')}>
          <option value="">{t('mcp.inbox.allOrigins')}</option>
          {CHANGE_ORIGINS.map((o) => <option key={o} value={o}>{t(`mcp.inbox.origin.${o}`)}</option>)}
        </SelectField>
      </div>}>
      {list.error ? <Card><ErrorState error={list.error} onRetry={list.reload} locale={locale} /></Card>
        : list.loading && !list.data ? <SkeletonCards count={3} height={96} />
          : !list.data?.items.length ? <Card><EmptyState title={t('mcp.inbox.empty.title')}>{t('mcp.inbox.empty.body')}</EmptyState></Card>
            : (
              <ul className="cx-list" aria-label={t('mcp.inbox.title')}>
                {list.data.items.map((cs) => (
                  <li key={cs.id} className="cx-item">
                    <div className="spread">
                      <Link className="cx-item-title" href={`${base}/${cs.id}`} dir="auto">{cs.title}</Link>
                      <SetStatusBadge status={cs.status} />
                    </div>
                    <div className="cx-meta">
                      <span>{t(`mcp.inbox.origin.${cs.origin}`)}</span>
                      <span>{t('mcp.inbox.ops', { n: cs.opCount })}: {cs.opTypes.map(opTitle).join(locale === 'ar' ? '، ' : ', ')}</span>
                      <span>{t('mcp.inbox.created', { date: dateTime(cs.createdAt, locale, org.timezone) })}</span>
                      {cs.status === 'pending_approval' && cs.expiresAt && <span>{t('mcp.inbox.expires', { date: dateTime(cs.expiresAt, locale, org.timezone) })}</span>}
                    </div>
                    {cs.status === 'pending_approval' && (
                      <div className="row gap-6">
                        <Badge tone="info">{t('mcp.inbox.requires', { n: Math.max(1, cs.policy.approvalsRequired) })}</Badge>
                        {cs.policy.requiresOwner && <Badge tone="warn">{t('mcp.inbox.ownerRequired')}</Badge>}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
    </ListPage>
  );
}
