'use client';
import { INTL_LOCALE } from '@resuto/contracts';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import type { Permission } from '@resuto/contracts';
import { EmptyState, Notice, PageHeader, SelectField } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import type { ApiRequestError } from '@/lib/api';
import { useT } from '@/lib/i18n/client';
import { pick } from '@/lib/format';
import { useOrg } from '@/lib/org-context';

const TABS: Array<{ href: string; key: string; permission?: Permission }> = [
  { href: '', key: 'insights' },
  { href: '/forecast', key: 'forecast' },
  { href: '/customers', key: 'customers' },
  { href: '/recommendations', key: 'recommendations' },
  { href: '/routes', key: 'routes', permission: 'delivery:dispatch' },
  { href: '/assistant', key: 'assistant' },
  { href: '/research', key: 'research' },
];

/** Header, sub-navigation and module/permission gate shared by every intelligence page. */
export function IntelShell({ children, actions }: { children: ReactNode; actions?: ReactNode }) {
  const { t } = useT();
  const { org, can } = useOrg();
  const pathname = usePathname();
  const base = `/dashboard/${org.id}/intelligence`;
  return (
    <ModuleGate module="intelligence" permission="ai:use">
      <PageHeader overline={t('nav.group.intelligence')} title={t('intelligence.title')} subtitle={t('intelligence.subtitle')} actions={actions} />
      <nav aria-label={t('intelligence.title')} className="row" style={{ gap: 6, marginBlockEnd: 18, overflowX: 'auto', flexWrap: 'nowrap', paddingBlockEnd: 4 }}>
        {TABS.filter((tab) => !tab.permission || can(tab.permission)).map((tab) => {
          const href = base + tab.href;
          const active = tab.href === '' ? pathname === base : pathname.startsWith(href);
          return (
            <Link key={tab.key} href={href} aria-current={active ? 'page' : undefined}
              className={`btn btn-sm btn-pill ${active ? 'btn-primary' : 'btn-ghost'}`} style={{ whiteSpace: 'nowrap' }}>
              {t(`intelligence.tab.${tab.key}`)}
            </Link>
          );
        })}
      </nav>
      {children}
    </ModuleGate>
  );
}

const BRANCH_KEY = 'resuto_intel_branch';

/** Selected branch (remembered per browser; falls back to the first active branch). */
export function useBranch() {
  const { org } = useOrg();
  const active = org.branches.filter((b) => b.isActive);
  const [branchId, setBranchId] = useState<string>(active[0]?.id ?? '');
  useEffect(() => {
    try {
      const saved = localStorage.getItem(BRANCH_KEY);
      if (saved && active.some((b) => b.id === saved)) setBranchId(saved);
    } catch { /* storage unavailable */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org.id]);
  const choose = (id: string) => {
    setBranchId(id);
    try { localStorage.setItem(BRANCH_KEY, id); } catch { /* storage unavailable */ }
  };
  return { branchId, setBranchId: choose, branches: active };
}

export function BranchSelect({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const { t, locale } = useT();
  const { org } = useOrg();
  const branches = org.branches.filter((b) => b.isActive);
  if (branches.length < 2) return null;
  return (
    <SelectField label={t('intelligence.branch')} value={value} onChange={(e) => onChange(e.target.value)}>
      {branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
    </SelectField>
  );
}

/** Error state with a specific message when the AI service is down or not configured. */
export function ApiErrorNotice({ error, onRetry }: { error: ApiRequestError | Error | null; onRetry?: () => void }) {
  const { t } = useT();
  if (!error) return null;
  const code = (error as ApiRequestError).code;
  const msg = code === 'ai_service_unavailable' ? t('intelligence.serviceDown')
    : code === 'ai_service_not_configured' ? t('intelligence.notConfigured') : error.message;
  return (
    <div className="stack">
      <Notice tone={code === 'ai_service_unavailable' ? 'warn' : 'danger'}>{msg}</Notice>
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
