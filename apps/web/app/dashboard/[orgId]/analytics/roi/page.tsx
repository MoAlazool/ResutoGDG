'use client';
// Insights › ROI calculator: a hypothetical scenario from explicit assumptions (nothing is stored; no period).
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import { RoiCalculator } from '../_parts/roi';

function View() {
  const { branchId } = useInsights();
  return <RoiCalculator branchId={branchId} />;
}

export default function Page() {
  return <InsightsShell section="roi"><View /></InsightsShell>;
}
