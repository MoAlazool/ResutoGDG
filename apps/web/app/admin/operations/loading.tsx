import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Operator console (Operations): placeholder in the page's template while the screen loads; the console shell stays (21-ADMIN). */
export default function OperationsLoading() {
  return <AreaSkeleton template="dashboard" />;
}
