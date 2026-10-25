import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Settings area (data): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function DataLoading() {
  return <AreaSkeleton template="settings" />;
}
