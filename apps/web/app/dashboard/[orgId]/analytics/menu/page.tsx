'use client';
// Insights › Menu performance: top and underperforming dishes and gross margin for the period (the former Products tab).
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import { ProductsPanel } from '../_parts/panels';

function View() {
  const { period, branchId } = useInsights();
  return <ProductsPanel period={period} branchId={branchId} />;
}

export default function Page() {
  return <InsightsShell section="menu"><View /></InsightsShell>;
}
