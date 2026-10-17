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
  if (permission && !can(permission)) return <div className="card"><EmptyState title={t('state.locked')}>{permission}</EmptyState></div>;
  return <>{children}</>;
}
