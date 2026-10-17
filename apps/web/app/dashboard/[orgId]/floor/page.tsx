'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { EmptyState, PageHeader, Tabs, ToastProvider } from '@resuto/ui';
import { FloorStudio } from '@/components/floor/FloorStudio';
import { LiveFloor } from '@/components/floor/LiveFloor';
import { QrSheet } from '@/components/floor/QrSheet';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { pick } from '@/lib/format';

type Tab = 'studio' | 'live' | 'qr';

function FloorPageInner() {
  const { t, locale } = useT();
  const { org, can } = useOrg();
  const router = useRouter();
  const params = useSearchParams();
  const branches = org.branches.filter((b) => b.isActive);
  const branchId = branches.some((b) => b.id === params.get('branch')) ? params.get('branch')! : branches[0]?.id;
  const canWrite = can('floor:write');
  const tabs: Array<{ key: Tab; label: string }> = [
    { key: 'live', label: t('studio.tab.live') },
    { key: 'studio', label: t('studio.tab.studio') },
    ...(canWrite ? [{ key: 'qr' as Tab, label: t('studio.tab.qr') }] : []),
  ];
  const requested = params.get('tab') as Tab | null;
  const tab: Tab = tabs.some((x) => x.key === requested) ? requested! : canWrite ? 'studio' : 'live';
  const go = (next: { tab?: Tab; branch?: string }) => {
    const q = new URLSearchParams(params.toString());
    if (next.tab) q.set('tab', next.tab);
    if (next.branch) q.set('branch', next.branch);
    router.replace(`?${q.toString()}`, { scroll: false });
  };
  const branch = branches.find((b) => b.id === branchId);

  return (
    <>
      {tab !== 'studio' && <PageHeader overline={t('nav.floor')} title={tab === 'live' ? t('studio.live.title') : t('studio.qr.title')} subtitle={t('studio.floor.pageSubtitle')} />}
      <div className="spread" style={{ alignItems: 'flex-start' }}>
        <Tabs tabs={tabs} value={tab} onChange={(k) => go({ tab: k })} label={t('nav.floor')} />
        {branches.length > 1 && (
          <label className="row" style={{ gap: 8 }}>
            <span className="fine">{t('studio.branch')}</span>
            <select className="select" style={{ width: 'auto', minHeight: 38 }} value={branchId} onChange={(e) => go({ branch: e.target.value })}>
              {branches.map((b) => <option key={b.id} value={b.id}>{pick(locale, b.name, b.nameAr)}</option>)}
            </select>
          </label>
        )}
      </div>
      {!branch ? (
        <div className="card"><EmptyState title={t('studio.noBranchTitle')}>{t('studio.noBranchBody')}</EmptyState></div>
      ) : tab === 'live' ? (
        <LiveFloor key={branch.id} orgId={org.id} branchId={branch.id} currency={org.currency} timezone={org.timezone} canSeat={can('floor:seat')} />
      ) : tab === 'qr' ? (
        <QrSheet key={branch.id} orgId={org.id} branchId={branch.id} branchName={pick(locale, branch.name, branch.nameAr)} restaurantName={pick(locale, org.name, org.nameAr)} />
      ) : (
        <FloorStudio key={branch.id} orgId={org.id} branchId={branch.id} branchName={pick(locale, branch.name, branch.nameAr)} currency={org.currency} canWrite={canWrite} />
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
