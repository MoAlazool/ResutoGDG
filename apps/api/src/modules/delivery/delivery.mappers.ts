import type { DeliveryJobView, DriverView } from '@resuto/contracts';
import { googleMapsDirectionsUrl } from '@resuto/integrations';

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/** Columns needed by toJobView (join delivery_jobs j, orders o, branches b, drivers d, live offer ofr). */
export const JOB_SELECT = `
  select j.*, o.number as order_number, o.status as order_status, o.total_minor as order_total_minor, o.currency,
         o.customer_id, b.name as branch_name, b.address as branch_address, d.display_name as driver_name,
         ofr.id as offer_id, ofr.driver_id as offer_driver_id, ofr.expires_at as offer_expires_at
    from delivery_jobs j
    join orders o on o.id = j.order_id
    join branches b on b.id = j.branch_id
    left join drivers d on d.id = j.driver_id
    left join delivery_offers ofr on ofr.job_id = j.id and ofr.status = 'offered'`;

export function toJobView(r: any): DeliveryJobView {
  const dropoff = r.dropoff ?? {};
  const dLat = num(r.dropoff_latitude), dLng = num(r.dropoff_longitude);
  const destination = dLat !== null && dLng !== null ? { latitude: dLat, longitude: dLng }
    : [dropoff.line1, dropoff.area, dropoff.city].filter(Boolean).join(', ') || null;
  return {
    id: r.id,
    orderId: r.order_id,
    orderNumber: r.order_number,
    orderStatus: r.order_status,
    branchId: r.branch_id,
    branchName: r.branch_name ?? null,
    status: r.status,
    driverId: r.driver_id,
    driverName: r.driver_name ?? null,
    dropoff: {
      line1: dropoff.line1 ?? '', area: dropoff.area ?? null, city: dropoff.city ?? null, notes: dropoff.notes ?? null,
      customerName: dropoff.customerName ?? null, customerPhone: dropoff.customerPhone ?? null, latitude: dLat, longitude: dLng,
    },
    pickup: { latitude: num(r.pickup_latitude), longitude: num(r.pickup_longitude), address: r.branch_address ?? null },
    distanceM: r.distance_m,
    etaAt: iso(r.eta_at),
    currency: r.currency,
    orderTotalMinor: r.order_total_minor,
    codAmountMinor: r.cod_amount_minor,
    cashCollectedMinor: r.cash_collected_minor,
    cashStatus: r.cash_status,
    hasOtp: !!r.delivery_otp_hash,
    offer: r.offer_id ? { id: r.offer_id, driverId: r.offer_driver_id, expiresAt: iso(r.offer_expires_at)! } : null,
    failureReason: r.failure_reason,
    proofRecipient: r.proof_recipient,
    assignedAt: iso(r.assigned_at),
    acceptedAt: iso(r.accepted_at),
    pickedUpAt: iso(r.picked_up_at),
    deliveredAt: iso(r.delivered_at),
    createdAt: iso(r.created_at)!,
    version: r.version,
    navigationUrl: destination ? googleMapsDirectionsUrl(destination) : null,
  };
}

/** Columns needed by toDriverView. */
export const DRIVER_SELECT = `
  select d.*,
         (select count(*)::int from delivery_jobs j where j.driver_id = d.id and j.status in ('assigned', 'accepted', 'picked_up', 'en_route')) as active_jobs,
         (select coalesce(sum(j.cash_collected_minor), 0)::bigint from delivery_jobs j where j.driver_id = d.id and j.cash_status = 'collected') as cash_on_hand
    from drivers d`;

export function toDriverView(r: any): DriverView {
  const lat = num(r.last_latitude), lng = num(r.last_longitude);
  return {
    id: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    phone: r.phone_e164,
    vehicleType: r.vehicle_type,
    vehiclePlate: r.vehicle_plate,
    branchIds: r.branch_ids,
    status: r.status,
    availability: r.availability,
    lastLocation: lat !== null && lng !== null && r.last_location_at ? { latitude: lat, longitude: lng, at: iso(r.last_location_at)! } : null,
    activeJobs: Number(r.active_jobs ?? 0),
    cashOnHandMinor: Number(r.cash_on_hand ?? 0),
  };
}

export const toEventView = (e: any) => ({
  id: Number(e.id), fromStatus: e.from_status, toStatus: e.to_status, actorType: e.actor_type, actorId: e.actor_id,
  latitude: num(e.latitude), longitude: num(e.longitude), details: e.details, createdAt: iso(e.created_at),
});

/** Cursor for (created_at desc, id desc) lists. */
export const encodeCursor = (createdAt: string | Date, id: string) => Buffer.from(`${new Date(createdAt).toISOString()}|${id}`).toString('base64url');
export function decodeCursor(cursor?: string): { at: string; id: string } | null {
  if (!cursor) return null;
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!at || !id || Number.isNaN(Date.parse(at)) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
  return { at, id };
}
