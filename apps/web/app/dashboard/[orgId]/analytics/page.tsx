'use client';
import { useState } from 'react';
import { PageHeader, Tabs } from '@resuto/ui';
import { ModuleGate } from '@/components/shell/ModuleGate';
import { PeriodPicker, presetPeriod, type Period, InsightsPage } from '@/components/charts/insights';
import { useUrlParam } from '@/components/ops/use-url-state';
import { useT } from '@/lib/i18n/client';
import { useBranchScope, useOrg } from '@/lib/org-context';
import { CustomersPanel, MarketingPanel, OperationsPanel, ProductsPanel, SalesPanel, SustainabilityPanel } from './_parts/panels';
import { RatingsPanel } from './_parts/ratings';
import { RoiCalculator } from './_parts/roi';

type Tab = 'sales' | 'products' | 'customers' | 'guests' | 'marketing' | 'operations' | 'sustainability' | 'roi';
const TABS: Tab[] = ['sales', 'products', 'customers', 'guests', 'marketing', 'operations', 'sustainability', 'roi'];

export default function AnalyticsPage() {
  const { t } = useT();
  const { org } = useOrg();
  // The tab is in the URL (?tab=guests), so the overview's "Needs attention" can link to a tab (21-HOME).
  const [tab, setTab] = useUrlParam<Tab>('tab', 'sales', TABS);
  const [period, setPeriod] = useState<Period>(() => presetPeriod('30d', org.timezone));
  // The branch comes from the shell's branch switcher ("All branches" supported).
  const { branchId } = useBranchScope({ allowAll: true });
  const props = { period, branchId };
  return (
    <ModuleGate module="core" permission="analytics:read"><InsightsPage>
      <PageHeader overline={t('nav.analytics')} title={t('insights.analytics.title')} subtitle={t('insights.analytics.subtitle')}
        actions={tab !== 'roi' ? <PeriodPicker value={period} onChange={setPeriod} /> : undefined} />
      <div style={{ overflowX: 'auto' }}>
        <Tabs tabs={TABS.map((k) => ({ key: k, label: t(`insights.analytics.tab.${k}`) }))} value={tab} onChange={setTab} />
      </div>
      {tab === 'sales' && <SalesPanel {...props} />}
      {tab === 'products' && <ProductsPanel {...props} />}
      {tab === 'customers' && <CustomersPanel {...props} />}
      {tab === 'guests' && <RatingsPanel {...props} />}
      {tab === 'marketing' && <MarketingPanel {...props} />}
      {tab === 'operations' && <OperationsPanel {...props} />}
      {tab === 'sustainability' && <SustainabilityPanel {...props} />}
      {tab === 'roi' && <RoiCalculator branchId={branchId} />}
    </InsightsPage></ModuleGate>
  );
}
