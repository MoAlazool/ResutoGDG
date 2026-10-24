import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Operations area (reservations): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function ReservationsLoading() {
  return <AreaSkeleton template="list" />;
}
