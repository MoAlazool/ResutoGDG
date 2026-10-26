'use client';
import { useSearchParams } from 'next/navigation';
import { lazy, Suspense } from 'react';
import { EmptyState, PageHeading, ToastProvider } from '@resuto/ui';
import { MenuQrCard } from '@/components/ops/MenuQrCard';
import { VenueQrCard } from '@/components/ops/ServiceMode';
import '@/components/ops/ops.css';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { pick } from '@/lib/format';

const QrSheet = lazy(() => import('@/components/floor/QrSheet').then((m) => ({ default: m.QrSheet })));

/**
 * QR codes (22-TYPE): the one place for every code guests scan, in the Menu & Store area. The ordering codes of the
 * branch chosen in the shell (the venue code of a counter branch, one code per table) and the view-only menu code.
 * The navigation's "QR codes" item opened the floor's QR tab before, which highlighted Operations and showed the
 * front-of-house tabs; the floor keeps that tab for staff working on the floor. `?branch=` wins over the shell's
 * branch, as on the floor page.
 */
function QrHub() {
  const { t, locale } = useT();
  const { org, can, branchId: shellBranch } = useOrg();
  const params = useSearchParams();
  const branches = org.branches.filter((b) => b.isActive !== false);
  const wanted = params.get('branch') ?? shellBranch;
  const branch = branches.find((b) => b.id === wanted) ?? branches[0];
  const restaurant = pick(locale, org.name, org.nameAr);
  return (
    <>
      <PageHeading title={t('nav.qrCodes')} subtitle={t('nav.qrHub.subtitle')} />
      {!branch ? (
        <div className="panel"><EmptyState title={t('studio.noBranchTitle')}>{t('studio.noBranchBody')}</EmptyState></div>
      ) : (
        <div className="stack gap-16">
          {branch.serviceMode === 'counter' && <VenueQrCard orgId={org.id} branchId={branch.id} canRotate={can('floor:write')} />}
          <Suspense fallback={<div className="card" aria-busy="true" />}>
            <QrSheet key={branch.id} orgId={org.id} branchId={branch.id} branchName={pick(locale, branch.name, branch.nameAr)} restaurantName={restaurant} />
          </Suspense>
          {can('menu:read') && <MenuQrCard orgId={org.id} orgSlug={org.slug} restaurantName={restaurant} branchCode={branch.code ?? null} />}
        </div>
      )}
    </>
  );
}

export default function QrPage() {
  const { t } = useT();
  return (
    <ModuleGate module="core" permission="floor:write">
      <ToastProvider closeLabel={t('action.close')}>
        <Suspense>
          <QrHub />
        </Suspense>
      </ToastProvider>
    </ModuleGate>
  );
}
