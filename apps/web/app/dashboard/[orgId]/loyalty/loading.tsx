import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Customers area (loyalty): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function LoyaltyLoading() {
  return <AreaSkeleton template="list" />;
}
