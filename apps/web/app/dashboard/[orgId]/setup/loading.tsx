import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Home area (setup): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function SetupLoading() {
  return <AreaSkeleton template="list" />;
}
