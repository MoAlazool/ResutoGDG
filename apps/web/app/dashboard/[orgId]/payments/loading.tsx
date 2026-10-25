import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Money area (payments): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function PaymentsLoading() {
  return <AreaSkeleton template="list" />;
}
