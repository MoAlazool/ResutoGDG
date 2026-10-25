import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Money area (compliance): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function ComplianceLoading() {
  return <AreaSkeleton template="list" />;
}
