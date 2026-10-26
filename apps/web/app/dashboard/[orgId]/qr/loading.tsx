import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Menu & Store area (QR codes): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function QrLoading() {
  return <AreaSkeleton template="list" />;
}
