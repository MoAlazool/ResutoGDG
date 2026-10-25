import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Customers area (customers): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function CustomersLoading() {
  return <AreaSkeleton template="list" />;
}
