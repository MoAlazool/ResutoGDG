import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Operations area (floor): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function FloorLoading() {
  return <AreaSkeleton template="workspace" />;
}
