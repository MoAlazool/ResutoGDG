import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Insights area (analytics): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function AnalyticsLoading() {
  return <AreaSkeleton template="dashboard" />;
}
