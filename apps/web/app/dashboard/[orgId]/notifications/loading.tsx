import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Home area (notifications): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function NotificationsLoading() {
  return <AreaSkeleton template="list" />;
}
