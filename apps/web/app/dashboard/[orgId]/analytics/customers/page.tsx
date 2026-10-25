'use client';
// Insights › Customers: identified, new and returning customers and retention cohorts for the period (measured), then
// the intelligence segments and churn risk (estimated; the former /intelligence/customers, which redirects here).
import dynamic from 'next/dynamic';
import { InsightsShell, useInsights } from '@/components/insights/InsightsShell';
import { useOrg } from '@/lib/org-context';
import { CustomersPanel } from '../_parts/panels';

const SegmentsPanel = dynamic(() => import('../_parts/segments').then((m) => m.SegmentsPanel), { ssr: false, loading: () => <div className="skeleton" aria-hidden="true" /> });

function View() {
  const { period, branchId } = useInsights();
  const { can, hasModule } = useOrg();
  return (
    <div className="stack gap-16">
      <CustomersPanel period={period} branchId={branchId} />
      {hasModule('intelligence') && can('ai:use') && <SegmentsPanel />}
    </div>
  );
}

export default function Page() {
  return <InsightsShell section="customers"><View /></InsightsShell>;
}
