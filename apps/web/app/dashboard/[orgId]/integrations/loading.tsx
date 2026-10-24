import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** AI & Apps area (integrations): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function IntegrationsLoading() {
  return <AreaSkeleton template="list" />;
}
