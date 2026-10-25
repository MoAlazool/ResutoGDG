import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Money area (finance): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function FinanceLoading() {
  return <AreaSkeleton template="list" />;
}
