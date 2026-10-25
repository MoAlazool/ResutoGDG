import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Menu & Store area (menu-import): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function MenuImportLoading() {
  return <AreaSkeleton template="list" />;
}
