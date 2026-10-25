import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Operations area (kitchen): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function KitchenLoading() {
  return <AreaSkeleton template="board" />;
}
