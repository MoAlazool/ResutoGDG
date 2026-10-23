'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { EmptyState, PageHeading, Tabs, ToastProvider } from '@resuto/ui';
import { ActiveVisits } from '@/components/ops/ActiveVisits';
import { VenueQrCard } from '@/components/ops/ServiceMode';
import { FloorStudio } from '@/components/floor/FloorStudio';
import { LiveFloor } from '@/components/floor/LiveFloor';
import { canForceClose } from '@/components/floor/visit-actions';
import { QrSheet } from '@/components/floor/QrSheet';
import '@/components/ops/ops.css';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { pick } from '@/lib/format';

type Tab = 'live' | 'visits' | 'studio' | 'qr';

/**
 * Floor (legacy "Floor overview" + "Active visits" + /manager/floor-editor). The live floor opens first for everyone
 * (VS-11); the Studio is a full-screen editor with "Back to service" (VS-23). The branch is the one chosen in the
 * shell (?branch= wins, so links keep working).
 */
function FloorPageInner() {
  const { t, locale } = useT();
  const { org, can, branchId: shellBranch } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const branches = org.branches.filter((b) => b.isActive);
  const wanted = params.get('branch') ?? shellBranch;
  const branchId = branches.some((b) => b.id === wanted) ? wanted! : branches[0]?.id;
  const canWrite = can('floor:write');
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'live', label: t('ops.floor.tab.live') },
    { key: 'visits', label: t('ops.floor.tab.visits') },
    { key: 'studio', label: t('studio.tab.studio') },
    ...(canWrite ? [{ key: 'qr' as Tab, label: t('studio.tab.qr') }] : []),
  ];
  const requested = params.get('tab') as Tab | null;
  const tab: Tab = tabs.some((x) => x.key === requested) ? requested! : 'live';
  const href = (next: Tab) => {
    const q = new URLSearchParams(params.toString());
    q.set('tab', next);
    if (branchId) q.set('branch', branchId);
    return `?${q.toString()}`;
  };
  const branch = branches.find((b) => b.id === branchId);

  return (
    <>
      <div className="spread floor-tabs">
        <Tabs tabs={tabs} value={tab} onChange={(k) => router.replace(href(k), { scroll: false })} label={t('nav.floor')} />
      </div>
      {!branch ? (
        <div className="panel"><EmptyState title={t('studio.noBranchTitle')}>{t('studio.noBranchBody')}</EmptyState></div>
      ) : tab === 'live' ? (
        <LiveFloor key={branch.id} orgId={org.id} branchId={branch.id} currency={org.currency} timezone={org.timezone}
          canSeat={can('floor:seat')} canForce={canForceClose(org.role)} canWrite={canWrite} canResolve={can('floor:seat') || can('orders:status')}
          qrHref={href('qr')} studioHref={href('studio')} />
      ) : tab === 'visits' ? (
        <ActiveVisits key={branch.id} orgId={org.id} branchId={branch.id} timezone={org.timezone} canClose={can('floor:seat')} canForce={canForceClose(org.role)}
          ordersHref={can('orders:read') ? `/dashboard/${org.id}/orders` : null} canCollect={can('payments:collect')} />
      ) : tab === 'qr' ? (
        <>
          <PageHeading title={t('studio.qr.title')} subtitle={t('studio.floor.pageSubtitle')} />
          {/* Counter branches print one venue code (FT-07); table codes stay available for any tables kept on the plan. */}
          {branch.serviceMode === 'counter' && <VenueQrCard orgId={org.id} branchId={branch.id} canRotate={canWrite} />}
          <QrSheet key={branch.id} orgId={org.id} branchId={branch.id} branchName={pick(locale, branch.name, branch.nameAr)} restaurantName={pick(locale, org.name, org.nameAr)} />
        </>
      ) : (
        <div className="studio-fullbleed">
          <FloorStudio key={branch.id} orgId={org.id} branchId={branch.id} branchName={pick(locale, branch.name, branch.nameAr)} currency={org.currency}
            canWrite={canWrite} backHref={href('live')} choices />
        </div>
      )}
    </>
  );
}

export default function FloorPage() {
  const { t } = useT();
  return (
    <ModuleGate module="core" permission="floor:read">
      <ToastProvider closeLabel={t('action.close')}>
        <Suspense>
          <FloorPageInner />
        </Suspense>
      </ToastProvider>
    </ModuleGate>
  );
}
