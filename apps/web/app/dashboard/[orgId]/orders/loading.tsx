import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Operations area (orders): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function OrdersLoading() {
  return <AreaSkeleton template="board" />;
}
