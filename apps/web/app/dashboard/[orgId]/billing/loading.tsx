import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Settings area (billing): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function BillingLoading() {
  return <AreaSkeleton template="settings" />;
}
