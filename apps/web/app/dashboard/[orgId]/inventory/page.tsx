'use client';
import { useEffect, useState } from 'react';
import { PageHeader, Tabs } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { useT } from '@/lib/i18n/client';
import { useOrg } from '@/lib/org-context';
import { AlertsTab, HistoryTab, ItemsTab, LevelsTab, MovementTab, RecipesTab, ValueWasteTab } from './_parts/tabs';

const TABS = ['levels', 'movement', 'items', 'recipes', 'alerts', 'waste', 'history'] as const;
type Tab = (typeof TABS)[number];

export default function InventoryPage() {
  const { t } = useT();
  const { can } = useOrg();
  const [tab, setTab] = useState<Tab>('levels');
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get('tab');
    if (q && (TABS as readonly string[]).includes(q)) setTab(q as Tab);
  }, []);
  const writable = can('inventory:write');
  const visible = TABS.filter((k) => writable || k !== 'movement');
  return (
    <ModuleGate module="core" permission="inventory:read">
      <PageHeader overline={t('nav.inventory')} title={t('insights.inventory.title')} subtitle={t('insights.inventory.subtitle')} />
      <div style={{ overflowX: 'auto' }}>
        <Tabs tabs={visible.map((k) => ({ key: k, label: t(`insights.inventory.tab.${k}`) }))} value={tab} onChange={setTab} />
      </div>
      {tab === 'levels' && <LevelsTab onRecord={writable ? () => setTab('movement') : undefined} />}
      {tab === 'movement' && writable && <MovementTab />}
      {tab === 'items' && <ItemsTab />}
      {tab === 'recipes' && <RecipesTab />}
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'waste' && <ValueWasteTab />}
      {tab === 'history' && <HistoryTab />}
    </ModuleGate>
  );
}
