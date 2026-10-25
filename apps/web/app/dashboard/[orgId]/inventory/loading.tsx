import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Operations area (inventory): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function InventoryLoading() {
  return <AreaSkeleton template="list" />;
}
