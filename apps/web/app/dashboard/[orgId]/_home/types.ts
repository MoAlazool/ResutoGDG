import type { AnalyticsMeta } from '@resuto/contracts';
import type { OverviewPeriod } from '@resuto/contracts/home';

/** GET /o/:orgId/analytics/overview as the overview reads it (21-HOME adds live.tables, live.stations, next and period). */
export interface OverviewData {
  date: string; localTime: string; currency: string;
  today: { orders: number; netMinor: number; averageOrderMinor: number };
  hourly: Array<{ hour: number; todayNetMinor: number; lastWeekNetMinor: number }>;
  live: {
    openOrders: number; byStatus: { awaitingPayment: number; placed: number; accepted: number; preparing: number; ready: number };
    oldestOpenOrderAt: string | null; openVisits: number;
    tables?: { total: number; occupied: number; outOfService: number; free: number };
    stations?: Array<{ station: string; queued: number; preparing: number }>;
  };
  reservationsToday: {
    total: number; guests: number; byStatus: Record<string, number>;
    next?: Array<{ id: string; branchId: string; guestName: string; partySize: number; startsAt: string; status: string; tableLabel: string | null }> | null;
  };
  lowStock: { count: number; items: Array<{ id: string; branchId: string; name: string; nameAr: string | null; unit: string; quantity: number; reorderLevel: number }> };
  period?: OverviewPeriod;
  meta: AnalyticsMeta;
}
