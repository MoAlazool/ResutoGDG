import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Operator console (Prices): placeholder in the page's template while the screen loads; the console shell stays (21-ADMIN). */
export default function PricesLoading() {
  return <AreaSkeleton template="list" />;
}
