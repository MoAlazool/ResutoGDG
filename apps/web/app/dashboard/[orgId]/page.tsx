import { RouteMessages } from '@/lib/i18n/scope';
import OverviewPage from './_home/HomePage';

/**
 * The overview (21-HOME; the screen is _home/HomePage.tsx). Its copy is added here rather than in a layout, so the
 * module screens under this segment do not carry it (lib/i18n/route-families.ts, 21-PERF).
 */
export default function Page() {
  return <RouteMessages route="dashboard/home"><OverviewPage /></RouteMessages>;
}
