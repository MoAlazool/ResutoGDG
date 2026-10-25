import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Insights area (intelligence): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function IntelligenceLoading() {
  return <AreaSkeleton template="dashboard" />;
}
