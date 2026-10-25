'use client';
// Insights › an analytics view (21-INSIGHTS): /analytics/sales, menu, customers, ratings, marketing, operations,
// sustainability and roi (lib/insights.ts ANALYTICS_VIEWS). One route for the eight views; each view's panel and charts
// load on demand (their own chunk), under the shared shell, period toolbar and saved-report controls.
import dynamic from 'next/dynamic';
import { notFound, useParams } from 'next/navigation';
import type { ComponentType } from 'react';
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import { PeriodControls } from '@/components/insights/PeriodControls';
import { isAnalyticsView, PERIOD_SECTIONS, type AnalyticsView } from '@/lib/insights';
import type { PanelProps } from '../_parts/panels';

const loading = () => <div className="card"><div className="skeleton" aria-hidden="true" /></div>;
const VIEWS: Record<AnalyticsView, ComponentType<PanelProps>> = {
  sales: dynamic(() => import('../_parts/panels').then((m) => m.SalesPanel), { loading }),
  menu: dynamic(() => import('../_parts/panels').then((m) => m.ProductsPanel), { loading }),
  customers: dynamic(() => import('../_parts/customers-view').then((m) => m.CustomersView), { loading }),
  ratings: dynamic(() => import('../_parts/ratings').then((m) => m.RatingsPanel), { loading }),
  marketing: dynamic(() => import('../_parts/panels').then((m) => m.MarketingPanel), { loading }),
  operations: dynamic(() => import('../_parts/panels').then((m) => m.OperationsPanel), { loading }),
  sustainability: dynamic(() => import('../_parts/panels').then((m) => m.SustainabilityPanel), { loading }),
  roi: dynamic(() => import('../_parts/roi').then((m) => m.RoiCalculator), { loading }),
};

function View({ section }: { section: AnalyticsView }) {
  const { period, branchId, compare } = useInsights();
  const Panel = VIEWS[section];
  return <Panel period={period} branchId={branchId} compare={compare} />;
}

export default function AnalyticsViewPage() {
  const { section } = useParams<{ section: string }>();
  if (!isAnalyticsView(section)) notFound();
  return (
    <InsightsShell section={section} toolbar={PERIOD_SECTIONS.includes(section) ? <PeriodControls /> : undefined}>
      <View section={section} />
    </InsightsShell>
  );
}
