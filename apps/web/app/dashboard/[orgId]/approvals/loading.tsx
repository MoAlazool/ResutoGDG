import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** AI & Apps area (approvals inbox): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function ApprovalsLoading() {
  return <AreaSkeleton template="list" />;
}
