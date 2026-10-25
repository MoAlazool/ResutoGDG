import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Customers area (marketing): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function MarketingLoading() {
  return <AreaSkeleton template="list" />;
}
