'use client';
import { lazy, Suspense, useEffect, useState } from 'react';
import { ListPage, Skeleton, Tabs } from '@resuto/ui';
import { InsightsPage } from '@/components/charts/insights';
import { useUrlParam } from '@/components/ops/use-url-state';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { AlertsTab, HistoryTab, ItemsTab, MovementTab, RecipesTab, ValueWasteTab } from './_parts/tabs';
import { AvailabilityTab } from './_parts/availability';
import { LevelsList } from './_parts/levels';
import { DEFAULT_INVENTORY_TAB, INVENTORY_TABS, visibleInventoryTabs, type InventoryTab } from './_parts/tab-order';
import '@/components/ops/ops.css';
import './inventory.css';

// The stocktake sheet loads when it opens.
const StocktakeSheet = lazy(() => import('./_parts/stocktake').then((m) => ({ default: m.StocktakeSheet })));

export default function InventoryPage() {
  return <ModuleGate module="core" permission="inventory:read"><Suspense fallback={<Skeleton lines={6} />}><Inventory /></Suspense></ModuleGate>;
}

/**
 * Inventory (21-OPS ListPage): stock levels first, with what needs attention on top and the stocktake in a sheet;
 * dish availability, movements, items, recipes, alerts, waste and history in the following tabs. The tab lives in
 * the URL (?tab=; ?tab=stocktake opens the stocktake over the levels).
 */
function Inventory() {
  const { t } = useT();
  const { can } = useOrg();
  const writable = can('inventory:write');
  const visible = visibleInventoryTabs(writable);
  const [raw, setTab] = useUrlParam<InventoryTab | 'stocktake'>('tab', DEFAULT_INVENTORY_TAB, [...INVENTORY_TABS, 'stocktake']);
  const tab: InventoryTab = raw === 'stocktake' || !visible.includes(raw) ? 'levels' : raw;
  const [counting, setCounting] = useState(false);
  const [rev, setRev] = useState(0);
  useEffect(() => { if (raw === 'stocktake' && writable) setCounting(true); }, [raw, writable]);
  const label = (k: InventoryTab) => (k === 'availability' ? t('ops.avail.tab') : t(`insights.inventory.tab.${k}`));
  return (
    <InsightsPage>
      <ListPage header={{ eyebrow: t('nav.inventory'), title: t('insights.inventory.title'), subtitle: t('insights.inventory.subtitle') }}
        filters={<div className="inventory-tabs"><Tabs<InventoryTab> label={t('nav.inventory')} tabs={visible.map((k) => ({ key: k, label: label(k) }))} value={tab} onChange={setTab} /></div>}>
        {tab === 'levels' && <LevelsList key={rev} onRecord={writable ? () => setTab('movement') : undefined} onStocktake={writable ? () => setCounting(true) : undefined} />}
        {tab === 'availability' && <AvailabilityTab />}
        {tab === 'movement' && writable && <MovementTab />}
        {tab === 'items' && <ItemsTab />}
        {tab === 'recipes' && <RecipesTab />}
        {tab === 'alerts' && <AlertsTab />}
        {tab === 'waste' && <ValueWasteTab />}
        {tab === 'history' && <HistoryTab />}
      </ListPage>
      {counting && (
        <Suspense fallback={null}>
          <StocktakeSheet onSaved={() => setRev((n) => n + 1)} onClose={() => { setCounting(false); if (raw === 'stocktake') setTab('levels'); }} />
        </Suspense>
      )}
    </InsightsPage>
  );
}
