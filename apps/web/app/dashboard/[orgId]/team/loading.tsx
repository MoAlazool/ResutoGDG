import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Settings area (team): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function TeamLoading() {
  return <AreaSkeleton template="settings" />;
}
