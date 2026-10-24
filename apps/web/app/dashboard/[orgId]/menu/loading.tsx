import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Menu & Store area (menu): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function MenuLoading() {
  return <AreaSkeleton template="list" />;
}
