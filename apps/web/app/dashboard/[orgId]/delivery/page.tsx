'use client';
import { useState } from 'react';
import { PageHeader, Tabs } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { Board } from './_components/Board';
import { Cash } from './_components/Cash';
import { DispatchMap } from './_components/DispatchMap';
import { Drivers } from './_components/Drivers';
import { Zones } from './_components/Zones';

type Tab = 'board' | 'map' | 'drivers' | 'cash' | 'zones';

/** ResutoDriver dispatch: live board, driver roster and COD cash settlement. */
export default function DeliveryPage() {
  const { t, locale } = useT();
  const { org } = useOrg();
  const [tab, setTab] = useState<Tab>('board');
  const [branchId, setBranchId] = useState('');
  const branches = org.branches.filter((b) => b.isActive);
  return (
    <ModuleGate module="driver" permission="delivery:dispatch">
      <PageHeader title={t('driver.dispatch.title')} subtitle={t('driver.dispatch.subtitle')}
        actions={branches.length > 1 ? (
          <select className="select" style={{ minWidth: 180 }} value={branchId} onChange={(e) => setBranchId(e.target.value)} aria-label={t('driver.dispatch.branch')}>
            <option value="">{t('driver.dispatch.allBranches')}</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{locale === 'ar' && b.nameAr ? b.nameAr : b.name}</option>)}
          </select>
        ) : undefined} />
      <Tabs<Tab> value={tab} onChange={setTab} tabs={[
        { key: 'board', label: t('driver.dispatch.tab.board') },
        { key: 'map', label: t('dispatchMap.tab') },
        { key: 'drivers', label: t('driver.dispatch.tab.drivers') },
        { key: 'cash', label: t('driver.dispatch.tab.cash') },
        { key: 'zones', label: t('zones.tab') },
      ]} />
      {tab === 'board' && <Board branchId={branchId} />}
      {tab === 'drivers' && <Drivers />}
      {tab === 'cash' && <Cash />}
      {tab === 'map' && <DispatchMap branchId={branchId} />}
      {tab === 'zones' && <Zones key={branchId} branchId={branchId} />}
    </ModuleGate>
  );
}
