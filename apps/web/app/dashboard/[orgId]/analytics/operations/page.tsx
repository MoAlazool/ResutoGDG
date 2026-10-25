'use client';
// Insights › Operations: kitchen and delivery times for the period.
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import { OperationsPanel } from '../_parts/panels';

function View() {
  const { period, branchId } = useInsights();
  return <OperationsPanel period={period} branchId={branchId} />;
}

export default function Page() {
  return <InsightsShell section="operations"><View /></InsightsShell>;
}
