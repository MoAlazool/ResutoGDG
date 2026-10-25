import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** Settings area (settings): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function SettingsLoading() {
  return <AreaSkeleton template="settings" />;
}
