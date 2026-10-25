import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Customers area (inbox): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function InboxLoading() {
  return <AreaSkeleton template="workspace" />;
}
