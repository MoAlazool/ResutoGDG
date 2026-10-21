import { Injectable } from '@nestjs/common';
import type { DeliveryStatus, PublicDeliveryTracking } from '@resuto/contracts';
import type { Tx } from '../../common/db/db.service';

/** Driver positions older than this are not shown to the guest (the driver app may be offline). */
const FRESH_MS = 10 * 60_000;
const NAMED_STATUSES = new Set<DeliveryStatus>(['assigned', 'accepted', 'picked_up', 'en_route', 'delivered']);
/** About 110 m of latitude: enough to show progress, not a precise position. */
const coarse = (v: unknown) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 1000);
const point = (lat: unknown, lng: unknown) => {
  const a = coarse(lat), b = coarse(lng);
  return a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) ? null : { latitude: a, longitude: b };
};

/** FT-14: the guest-safe delivery view for an order's tracking page (latest delivery job of the order). */
@Injectable()
export class PublicTrackingService {
  async forOrder(tx: Tx, orderId: string, now = new Date()): Promise<PublicDeliveryTracking | null> {
    const j = await tx.maybeOne<any>(
      `select j.status, j.eta_at, j.picked_up_at, j.delivered_at, j.pickup_latitude, j.pickup_longitude, j.dropoff_latitude, j.dropoff_longitude,
              d.display_name, d.last_latitude, d.last_longitude, d.last_location_at
         from delivery_jobs j left join drivers d on d.id = j.driver_id
        where j.order_id = $1 order by j.created_at desc limit 1`, [orderId]);
    if (!j) return null;
    const status = j.status as DeliveryStatus;
    const fresh = j.last_location_at && now.getTime() - new Date(j.last_location_at).getTime() <= FRESH_MS;
    const live = status === 'en_route' && fresh ? point(j.last_latitude, j.last_longitude) : null;
    const closed = status === 'delivered' || status === 'failed' || status === 'cancelled';
    return {
      status,
      etaAt: !closed && j.eta_at ? new Date(j.eta_at).toISOString() : null,
      driverFirstName: NAMED_STATUSES.has(status) && j.display_name ? String(j.display_name).trim().split(/\s+/)[0]!.slice(0, 40) : null,
      pickedUpAt: j.picked_up_at ? new Date(j.picked_up_at).toISOString() : null,
      deliveredAt: j.delivered_at ? new Date(j.delivered_at).toISOString() : null,
      restaurant: point(j.pickup_latitude, j.pickup_longitude),
      destination: point(j.dropoff_latitude, j.dropoff_longitude),
      driver: live ? { ...live, at: new Date(j.last_location_at).toISOString() } : null,
    };
  }
}
