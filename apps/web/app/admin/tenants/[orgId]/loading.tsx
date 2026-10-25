import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Operator console (One restaurant): placeholder in the page's template while the screen loads; the console shell stays (21-ADMIN). */
export default function TenantLoading() {
  return <AreaSkeleton template="detail" />;
}
