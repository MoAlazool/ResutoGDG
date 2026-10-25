'use client';
// Insights › an analytics view (21-INSIGHTS): /analytics/sales, menu, customers, funnel, retention, ratings, marketing,
// operations, sustainability and roi (lib/insights.ts ANALYTICS_VIEWS). One route for the ten views (the sales charts load on
// demand), under the shared shell, period toolbar and saved-report controls. An unknown section opens the overview.
import dynamic from 'next/dynamic';
import { Skeleton } from '@resuto/ui';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, type ComponentType } from 'react';
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import { PeriodControls } from '@/components/insights/PeriodControls';
import { isAnalyticsView, PERIOD_SECTIONS, type AnalyticsView } from '@/lib/insights';
import { MarketingPanel, OperationsPanel, ProductsPanel, SalesPanel, SustainabilityPanel, type PanelProps } from '../_parts/panels';
import { CustomersView } from '../_parts/customers-view';
import { RatingsPanel } from '../_parts/ratings';
import { RoiCalculator } from '../_parts/roi';

// 21-CRM: the growth funnel and retention views load on demand, so the rest of Insights does not carry their charts.
const loading = () => <div className="card"><Skeleton lines={6} /></div>;
const FunnelPanel = dynamic(() => import('@/components/crm/FunnelPanels').then((m) => m.FunnelPanel), { ssr: false, loading });
const RetentionPanel = dynamic(() => import('@/components/crm/FunnelPanels').then((m) => m.RetentionPanel), { ssr: false, loading });

const VIEWS: Record<AnalyticsView, ComponentType<PanelProps>> = {
  sales: SalesPanel, menu: ProductsPanel, customers: CustomersView, funnel: FunnelPanel, retention: RetentionPanel, ratings: RatingsPanel, marketing: MarketingPanel,
  operations: OperationsPanel, sustainability: SustainabilityPanel, roi: RoiCalculator,
};

function View({ section }: { section: AnalyticsView }) {
  const { period, branchId, compare } = useInsights();
  const Panel = VIEWS[section];
  return <Panel period={period} branchId={branchId} compare={compare} />;
}

export default function AnalyticsViewPage() {
  const { section, orgId } = useParams<{ section: string; orgId: string }>();
  const router = useRouter();
  const known = isAnalyticsView(section);
  useEffect(() => { if (!known) router.replace(`/dashboard/${orgId}/analytics`); }, [known, orgId, router]);
  if (!known) return null;
  return (
    <InsightsShell section={section} toolbar={PERIOD_SECTIONS.includes(section) ? <PeriodControls /> : undefined}>
      <View section={section} />
    </InsightsShell>
  );
}
