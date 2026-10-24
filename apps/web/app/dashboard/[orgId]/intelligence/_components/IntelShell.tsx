'use client';
import { INTL_LOCALE } from '@resuto/contracts';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { EmptyState, Notice, PageHeader } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { SectionNav } from '@/components/shell/SectionNav';
import { INTELLIGENCE_SECTIONS } from '@/lib/sections';
import type { ApiRequestError } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { useBranchScope, useOrg } from '@/lib/org-context';

/** Header, sub-navigation and module/permission gate shared by every intelligence page. */
export function IntelShell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const { t } = useT();
  return (
    <ModuleGate module="intelligence" permission="ai:use">
      <PageHeader overline={t('nav.group.intelligence')} title={t('intelligence.title')} subtitle={t('intelligence.subtitle')} actions={actions} />
      <SectionNav sections={INTELLIGENCE_SECTIONS} label={t('intelligence.title')} />
      {children}
    </ModuleGate>
  );
}

/**
 * The branch these screens work on: the shell's branch switcher (21-SHELL single branch context). Forecasts,
 * recommendations and routes are per branch, so "All branches" is not offered here.
 */
export function useBranch() {
  const { org } = useOrg();
  const { branchId } = useBranchScope();
  return { branchId, branches: org.branches.filter((b) => b.isActive) };
}

/** Error state with a specific message when the AI service is down or not configured. */
export function ApiErrorNotice({ error, onRetry }: { error: ApiRequestError | Error | null; onRetry?: () => void }) {
  const { t } = useT();
  const { org } = useOrg();
  if (!error) return null;
  const code = (error as ApiRequestError).code;
  const details = (error as ApiRequestError).details as { limit?: string; allowed?: number } | undefined;
  const quota = code === 'plan_limit_reached' && details?.limit === 'ai_requests_per_month';
  const msg = code === 'ai_service_unavailable' ? t('intelligence.serviceDown')
    : code === 'ai_service_not_configured' ? t('intelligence.notConfigured')
      : quota ? t('intelligence.quotaReached', { allowed: Number(details?.allowed ?? 0) }) : error.message;
  return (
    <div className="stack">
      <Notice tone={code === 'ai_service_unavailable' || quota ? 'warn' : 'danger'}>{msg}</Notice>
      {quota && <div><Link className="btn btn-sm btn-primary" href={`/dashboard/${org.id}/billing`}>{t('intelligence.quotaUpgrade')}</Link></div>}
      {onRetry && <div><button type="button" className="btn btn-sm" onClick={onRetry}>{t('action.retry')}</button></div>}
    </div>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return <div className="card"><EmptyState title={title}>{body}</EmptyState></div>;
}

export const fmtNum = (n: number | null | undefined, locale: string, digits = 1) =>
  n === null || n === undefined ? '—' : new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-GB', { maximumFractionDigits: digits }).format(n);
export const fmtPct = (n: number | null | undefined, locale: string) =>
  n === null || n === undefined ? '—' : new Intl.NumberFormat(locale === 'ar' ? INTL_LOCALE.ar : 'en-GB', { style: 'percent', maximumFractionDigits: 1 }).format(n);
