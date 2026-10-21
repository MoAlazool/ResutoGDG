import { Injectable } from '@nestjs/common';
import type { DeliveryZone, DeliveryZoneInput, PublicServiceArea } from '@resuto/contracts';
import type { TenantContext } from '../../common/auth/context';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, invalid, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import type { ServiceAreaBranch, ServiceAreaInput, ServiceAreaPort, ServiceAreaResult } from '../kernel/ports';
import type { OpeningHour } from '../reservations/availability';
import { distanceM, nextOpening, openAt, zonesCovering, type LatLng, type ZoneRow } from './service-area';

/** Channels where a guest orders unattended: opening hours and delivery coverage are enforced (FT-09). */
const GUEST_CHANNELS = new Set(['web', 'whatsapp', 'messenger', 'instagram']);
const SCHEDULE_GRACE_MS = 5 * 60_000;
const SCHEDULE_HORIZON_MS = 14 * 86_400_000;
const ZONE_COLUMNS = 'id, branch_id, name, name_ar, kind, radius_m, polygon, fee_minor, min_order_minor, eta_min, sort_order, is_active';

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v));
const originOf = (b: ServiceAreaBranch): LatLng | null => {
  const lat = num(b.latitude), lng = num(b.longitude);
  return lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng) ? { latitude: lat, longitude: lng } : null;
};
const hoursOf = (v: unknown): OpeningHour[] => (Array.isArray(v) ? (v as OpeningHour[]) : []);
const toZone = (r: any): DeliveryZone => ({
  id: r.id, branchId: r.branch_id, name: r.name, nameAr: r.name_ar, kind: r.kind, radiusM: r.radius_m, polygon: r.polygon,
  feeMinor: Number(r.fee_minor), minOrderMinor: Number(r.min_order_minor), etaMin: r.eta_min, sortOrder: r.sort_order, isActive: r.is_active,
});

/**
 * FT-09 service area: the pricing engine asks it (SERVICE_AREA_PORT) whether a guest may order now or at the
 * scheduled time (opening hours in the branch's time zone) and which delivery zone prices the order (fee, minimum,
 * ETA) and covers the drop-off point. Staff channels are not held to opening hours and may choose any zone.
 */
@Injectable()
export class ServiceAreaService implements ServiceAreaPort {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  async check(tx: Tx, orgId: string, branch: ServiceAreaBranch, input: ServiceAreaInput): Promise<ServiceAreaResult> {
    const guest = GUEST_CHANNELS.has(input.channel ?? '');
    const now = Date.now();
    if (input.at) {
      const t = input.at.getTime();
      if (!Number.isFinite(t)) throw invalid('scheduled_invalid', 'Choose a valid time');
      if (t < now - SCHEDULE_GRACE_MS) throw invalid('scheduled_in_past', 'Choose a time in the future');
      if (t > now + SCHEDULE_HORIZON_MS) throw invalid('scheduled_too_far', 'Orders can be scheduled up to 14 days ahead');
    }
    const tz = branch.timezone || branch.org_timezone || 'UTC';
    const hours = hoursOf(branch.opening_hours);
    if (guest && !openAt(hours, tz, input.at ?? new Date(now))) {
      const next = nextOpening(hours, tz, new Date(Math.max(now, input.at?.getTime() ?? now)));
      throw new DomainError(input.at ? 'scheduled_while_closed' : 'branch_closed',
        input.at ? 'The restaurant is closed at that time. Choose a time within its opening hours.' : 'The restaurant is closed right now. Schedule the order for when it is open.',
        409, { nextOpenAt: next?.toISOString() ?? null, timezone: tz });
    }

    const base: ServiceAreaResult = { deliveryFeeMinor: Number(branch.delivery_fee_minor), minOrderMinor: Number(branch.min_order_minor), zone: null, zoneRequired: false };
    if (input.fulfillment !== 'delivery') return base;
    const zones = await this.activeZones(tx, orgId, branch.id);
    const origin = originOf(branch);
    const p = input.point ?? null;
    const outside = () => new DomainError('outside_delivery_area', 'This address is outside the restaurant’s delivery area', 409);

    if (!zones.length) {
      // No zones: the single branch radius (when set with branch coordinates) still bounds guest deliveries.
      if (guest && p && origin && branch.delivery_radius_m && distanceM(origin, p) > branch.delivery_radius_m) throw outside();
      return base;
    }
    let chosen: ZoneRow | null = null;
    if (input.zoneId) {
      chosen = zones.find((z) => z.id === input.zoneId) ?? null;
      if (!chosen) throw invalid('delivery_zone_invalid', 'Choose one of this branch’s delivery areas');
    }
    if (p) {
      const covering = zonesCovering(zones, origin, p);
      if (chosen) {
        if (guest && chosen.kind !== 'area' && !covering.some((z) => z.id === chosen!.id)) throw outside();
      } else {
        chosen = covering[0] ?? null;
        if (!chosen && guest && !zones.some((z) => z.kind === 'area')) throw outside();
      }
    } else if (chosen && guest && chosen.kind !== 'area') {
      throw new DomainError('location_required', 'Share your location so the restaurant can check it is in this delivery zone', 409);
    }
    if (!chosen) {
      if (!guest) return base; // staff and phone orders: the team knows the address; the branch fee applies.
      if (input.placing) {
        throw new DomainError('delivery_zone_required', 'Choose your delivery area', 409,
          { zones: zones.map((z) => ({ id: z.id, name: z.name, nameAr: z.name_ar, kind: z.kind })) });
      }
      return { ...base, zoneRequired: true };
    }
    return {
      deliveryFeeMinor: Number(chosen.fee_minor), minOrderMinor: Number(chosen.min_order_minor), zoneRequired: false,
      zone: { id: chosen.id, name: chosen.name, nameAr: chosen.name_ar, etaMin: chosen.eta_min },
    };
  }

  private activeZones(tx: Tx, orgId: string, branchId: string) {
    return tx.query<ZoneRow>(`select ${ZONE_COLUMNS} from delivery_zones where org_id = $1 and branch_id = $2 and is_active order by sort_order, fee_minor, name`, [orgId, branchId]);
  }

  // ---------------------------------------------------------------------------
  // Public view for the ordering pages
  // ---------------------------------------------------------------------------
  async publicView(slug: string, branchId: string): Promise<PublicServiceArea> {
    const org = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string }>(`select id from organizations where slug = $1 and status <> 'closed'`, [slug.toLowerCase()]));
    if (!org) throw notFound('Restaurant');
    return this.db.withTenant(org.id, async (tx) => {
      const b = await tx.maybeOne<any>(
        `select b.id, b.timezone, o.timezone as org_timezone, b.opening_hours, b.accepts_delivery, b.delivery_fee_minor, b.min_order_minor
           from branches b join organizations o on o.id = b.org_id where b.id = $1 and b.org_id = $2 and b.is_active`, [branchId, org.id]);
      if (!b) throw notFound('Branch');
      const tz = b.timezone || b.org_timezone || 'UTC';
      const hours = hoursOf(b.opening_hours);
      const now = new Date();
      const openNow = openAt(hours, tz, now);
      const zones = b.accepts_delivery ? await this.activeZones(tx, org.id, b.id) : [];
      return {
        branchId: b.id, timezone: tz, openNow, hoursSet: hours.length > 0,
        nextOpenAt: openNow || !hours.length ? null : nextOpening(hours, tz, now)?.toISOString() ?? null,
        delivery: {
          offered: !!b.accepts_delivery,
          zones: zones.map((z) => ({ id: z.id, name: z.name, nameAr: z.name_ar, kind: z.kind, feeMinor: Number(z.fee_minor), minOrderMinor: Number(z.min_order_minor), etaMin: z.eta_min })),
          defaultFeeMinor: Number(b.delivery_fee_minor), defaultMinOrderMinor: Number(b.min_order_minor),
        },
      };
    }, 'guest:service-area');
  }

  // ---------------------------------------------------------------------------
  // Zone management (branches:manage)
  // ---------------------------------------------------------------------------
  list(ctx: TenantContext, branchId?: string): Promise<{ items: DeliveryZone[] }> {
    if (branchId) ctx.assertBranch(branchId);
    return this.db.scoped(ctx, async (tx) => ({
      items: (await tx.query(`select ${ZONE_COLUMNS} from delivery_zones where org_id = $1 and ($2::uuid is null or branch_id = $2) order by branch_id, sort_order, name`,
        [ctx.orgId, branchId ?? null])).map(toZone),
    }));
  }

  create(ctx: TenantContext, input: DeliveryZoneInput) {
    ctx.assertBranch(input.branchId);
    return this.db.scoped(ctx, async (tx) => {
      await this.assertBranchOf(tx, ctx.orgId, input.branchId);
      const row = await tx.one(
        `insert into delivery_zones(org_id, branch_id, name, name_ar, kind, radius_m, polygon, fee_minor, min_order_minor, eta_min, sort_order, is_active)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning ${ZONE_COLUMNS}`,
        [ctx.orgId, input.branchId, input.name, input.nameAr ?? null, input.kind, input.radiusM ?? null, input.polygon ? JSON.stringify(input.polygon) : null,
          input.feeMinor, input.minOrderMinor, input.etaMin ?? null, input.sortOrder, input.isActive]);
      await this.audit.record(tx, ctx, { action: 'delivery.zone_created', entityType: 'delivery_zone', entityId: (row as any).id, branchId: input.branchId,
        metadata: { name: input.name, kind: input.kind, feeMinor: input.feeMinor, minOrderMinor: input.minOrderMinor } });
      return toZone(row);
    });
  }

  update(ctx: TenantContext, id: string, input: DeliveryZoneInput) {
    ctx.assertBranch(input.branchId);
    return this.db.scoped(ctx, async (tx) => {
      const before = await tx.maybeOne<any>(`select ${ZONE_COLUMNS} from delivery_zones where id = $1 and org_id = $2 for update`, [id, ctx.orgId]);
      if (!before) throw notFound('Delivery zone');
      ctx.assertBranch(before.branch_id);
      await this.assertBranchOf(tx, ctx.orgId, input.branchId);
      const row = await tx.one(
        `update delivery_zones set branch_id = $3, name = $4, name_ar = $5, kind = $6, radius_m = $7, polygon = $8, fee_minor = $9, min_order_minor = $10,
                eta_min = $11, sort_order = $12, is_active = $13, updated_at = now()
          where id = $1 and org_id = $2 returning ${ZONE_COLUMNS}`,
        [id, ctx.orgId, input.branchId, input.name, input.nameAr ?? null, input.kind, input.radiusM ?? null, input.polygon ? JSON.stringify(input.polygon) : null,
          input.feeMinor, input.minOrderMinor, input.etaMin ?? null, input.sortOrder, input.isActive]);
      await this.audit.record(tx, ctx, { action: 'delivery.zone_updated', entityType: 'delivery_zone', entityId: id, branchId: input.branchId,
        metadata: { before: { feeMinor: Number(before.fee_minor), minOrderMinor: Number(before.min_order_minor), isActive: before.is_active },
          after: { feeMinor: input.feeMinor, minOrderMinor: input.minOrderMinor, isActive: input.isActive } } });
      return toZone(row);
    });
  }

  remove(ctx: TenantContext, id: string) {
    return this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne<any>('delete from delivery_zones where id = $1 and org_id = $2 returning branch_id, name', [id, ctx.orgId]);
      if (!row) throw notFound('Delivery zone');
      ctx.assertBranch(row.branch_id);
      await this.audit.record(tx, ctx, { action: 'delivery.zone_deleted', entityType: 'delivery_zone', entityId: id, branchId: row.branch_id, metadata: { name: row.name } });
      return { ok: true };
    });
  }

  private async assertBranchOf(tx: Tx, orgId: string, branchId: string) {
    if (!(await tx.maybeOne('select 1 from branches where id = $1 and org_id = $2', [branchId, orgId]))) throw notFound('Branch');
  }
}
