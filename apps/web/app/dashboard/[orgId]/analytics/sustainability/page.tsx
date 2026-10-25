'use client';
// Insights › Sustainability (SDG 12): food waste and paper avoided for the period.
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import { SustainabilityPanel } from '../_parts/panels';

function View() {
  const { period, branchId } = useInsights();
  return <SustainabilityPanel period={period} branchId={branchId} />;
}

export default function Page() {
  return <InsightsShell section="sustainability"><View /></InsightsShell>;
}
