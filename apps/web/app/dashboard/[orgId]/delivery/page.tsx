'use client';
import { Suspense } from 'react';
import { ListPage, Skeleton, Tabs } from '@resuto/ui';
import { useUrlParam } from '@/components/ops/use-url-state';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { useBranchScope } from '@/lib/org-context';
import { Board } from './_components/Board';
import { Cash } from './_components/Cash';
import { Drivers } from './_components/Drivers';
import { Zones } from './_components/Zones';
import './delivery.css';

type Tab = 'board' | 'drivers' | 'cash' | 'zones';
const TABS: readonly Tab[] = ['board', 'drivers', 'cash', 'zones'];

/** ResutoDriver dispatch: the live map and board, driver roster, COD cash settlement and delivery zones. */
export default function DeliveryPage() {
  return <ModuleGate module="driver" permission="delivery:dispatch"><Suspense fallback={<Skeleton lines={6} />}><Delivery /></Suspense></ModuleGate>;
}

/**
 * The tab lives in the URL (PCL-20), so a reload keeps the dispatcher's view; the former "map" tab is now beside the
 * board (21-OPS), and ?tab=map still opens it. The branch is the shell's one branch context (21-SHELL), including
 * "All branches"; the page has no branch select of its own.
 */
function Delivery() {
  const { t } = useT();
  const [raw, setTab] = useUrlParam<Tab | 'map'>('tab', 'board', [...TABS, 'map']);
  const tab: Tab = raw === 'map' ? 'board' : raw;
  const { branchId } = useBranchScope({ allowAll: true });
  return (
    <ListPage header={{ title: t('driver.dispatch.title'), subtitle: t('driver.dispatch.subtitle') }}
      filters={<Tabs<Tab> value={tab} onChange={setTab} label={t('driver.dispatch.title')} tabs={[
        { key: 'board', label: t('driver.dispatch.tab.board') },
        { key: 'drivers', label: t('driver.dispatch.tab.drivers') },
        { key: 'cash', label: t('driver.dispatch.tab.cash') },
        { key: 'zones', label: t('zones.tab') },
      ]} />}>
      {tab === 'board' && <Board key={branchId} branchId={branchId} />}
      {tab === 'drivers' && <Drivers />}
      {tab === 'cash' && <Cash />}
      {tab === 'zones' && <Zones key={branchId} branchId={branchId} />}
    </ListPage>
  );
}
