import { AreaSkeleton } from '@/components/shell/AreaSkeleton';

/** AI & Apps area (mcp): placeholder in the page's template while the screen loads; the shell stays (21-SHELL). */
export default function McpLoading() {
  return <AreaSkeleton template="list" />;
}
