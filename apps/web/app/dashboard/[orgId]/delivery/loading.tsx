import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Operations area (delivery): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function DeliveryLoading() {
  return <AreaSkeleton template="board" />;
}
