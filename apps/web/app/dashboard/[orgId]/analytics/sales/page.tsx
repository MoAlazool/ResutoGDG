'use client';
// Insights › Sales: revenue, channels, service types, branches, payments and busy hours for the period, compared as the toolbar says.
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import { SalesPanel } from '../_parts/panels';

function View() {
  const { period, branchId, compare } = useInsights();
  return <SalesPanel period={period} branchId={branchId} compare={compare} />;
}

export default function Page() {
  return <InsightsShell section="sales"><View /></InsightsShell>;
}
