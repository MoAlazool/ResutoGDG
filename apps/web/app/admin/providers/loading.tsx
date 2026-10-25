import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Operator console (Provider apps): placeholder in the page's template while the screen loads; the console shell stays (21-ADMIN). */
export default function ProvidersLoading() {
  return <AreaSkeleton template="settings" />;
}
