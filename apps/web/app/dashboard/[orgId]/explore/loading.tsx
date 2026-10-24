import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Home area (explore): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function ExploreLoading() {
  return <AreaSkeleton template="list" />;
}
