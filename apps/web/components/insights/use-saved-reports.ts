'use client';
import type { Page } from '@resuto/contracts';
import type { SavedReport } from '@/lib/contracts-reports';
import { useOrg } from '@/lib/org-context';
import { useApi } from '@/lib/use-api';

/** GET /o/:orgId/reports: the member's saved reports and colleagues' shared ones (one page of up to 200). */
export const reportsPath = (orgId: string) => `/o/${orgId}/reports?limit=200`;

/** The saved reports the member can open: their own, then colleagues' shared ones. */
export function useSavedReports() {
  const { org } = useOrg();
  const list = useApi<Page<SavedReport>>(reportsPath(org.id));
  const items = list.data?.items ?? [];
  return { ...list, mine: items.filter((r) => r.mine), shared: items.filter((r) => !r.mine) };
}
