'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ModuleKey, Permission } from '@resuto/contracts';
import { EmptyState } from '@resuto/ui';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';

/** Wrap module pages: shows an upgrade prompt when not entitled (the API enforces regardless). */
export function ModuleGate({ module, permission, children }: { module: ModuleKey; permission?: Permission; children: ReactNode }) {
  const { t } = useT();
  const { org, hasModule, can } = useOrg();
  if (!hasModule(module)) {
    return (
      <div className="card"><EmptyState title={t('entitlement.title')} action={<Link className="btn btn-primary" href={`/dashboard/${org.id}/billing`}>{t('action.upgrade')}</Link>}>
        {t('entitlement.body')}
      </EmptyState></div>
    );
  }
  // The role cannot open this screen: say so in the page language (never the raw permission code).
  if (permission && !can(permission)) {
    return (
      <div className="card"><EmptyState title={t('shell.noAccess.title')} action={<Link className="btn" href={`/dashboard/${org.id}`}>{t('shell.noAccess.home')}</Link>}>
        {t('shell.noAccess.body', { role: t(`role.${org.role}`) })}
      </EmptyState></div>
    );
  }
  return <>{children}</>;
}
