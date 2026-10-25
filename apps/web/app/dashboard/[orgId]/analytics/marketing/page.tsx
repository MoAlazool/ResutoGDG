'use client';
// Insights › Marketing: campaign-attributed revenue against marketing cost for the period.
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import { MarketingPanel } from '../_parts/panels';

function View() {
  const { period, branchId } = useInsights();
  return <MarketingPanel period={period} branchId={branchId} />;
}

export default function Page() {
  return <InsightsShell section="marketing"><View /></InsightsShell>;
}
