import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Settings area (audit): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function AuditLoading() {
  return <AreaSkeleton template="settings" />;
}
