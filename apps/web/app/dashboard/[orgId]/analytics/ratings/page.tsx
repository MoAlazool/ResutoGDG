'use client';
// Insights › Ratings: what guests said after paying (the former Guests tab; the attention list links here).
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import { RatingsPanel } from '../_parts/ratings';

function View() {
  const { period, branchId } = useInsights();
  return <RatingsPanel period={period} branchId={branchId} />;
}

export default function Page() {
  return <InsightsShell section="ratings"><View /></InsightsShell>;
}
