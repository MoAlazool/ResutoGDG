import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Home area (overview): shown inside the staff shell while the next screen loads (the sidebar and topbar stay). */
export default function DashboardLoading() {
  return <AreaSkeleton template="dashboard" />;
}
