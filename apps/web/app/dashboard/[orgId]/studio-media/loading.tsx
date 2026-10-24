import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Menu & Store area (studio-media): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function StudioMediaLoading() {
  return <AreaSkeleton template="list" />;
}
