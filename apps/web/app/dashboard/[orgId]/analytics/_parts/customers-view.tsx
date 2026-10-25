'use client';
// Insights › Customers: identified, new and returning customers and retention cohorts for the period (measured), then
// the intelligence segments and churn risk (estimated; the former /intelligence/customers, which redirects here) for
// roles with ai:use on a plan with the intelligence module.
import dynamic from 'next/dynamic';
import { useOrg } from '@/lib/org-context';
import { CustomersPanel, type PanelProps } from './panels';

const SegmentsPanel = dynamic(() => import('./segments').then((m) => m.SegmentsPanel), { ssr: false, loading: () => <div className="skeleton" aria-hidden="true" /> });

export function CustomersView(props: PanelProps) {
  const { can, hasModule } = useOrg();
  return (
    <div className="stack gap-16">
      <CustomersPanel period={props.period} branchId={props.branchId} />
      {hasModule('intelligence') && can('ai:use') && <SegmentsPanel />}
    </div>
  );
}
