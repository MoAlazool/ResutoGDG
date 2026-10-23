import { Inject, Injectable } from '@nestjs/common';
import { VISIT_RULES, type FloorLayout, type FloorSaveInput, type FloorTable, type LiveFloor, type PublicFloor, type QrSheetItem } from '@resuto/contracts';
import QRCode from 'qrcode';
import type { TenantContext } from '../../common/auth/context';
import { newToken } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { IdempotencyService } from '../../common/platform/idempotency.service';
import { ENV, type Env } from '../../config/env';
import { planFloorSave, type CurrentTable } from './floor-rules';

const n = (v: unknown) => Number(v);

export const toFloorTable = (r: any): FloorTable => ({
  id: r.id, label: r.label, capacity: r.capacity, zone: r.zone, shape: r.shape, cx: n(r.cx), cy: n(r.cy), width: n(r.width), height: n(r.height),
  rotation: n(r.rotation), features: r.features, reservable: r.is_reservable, minSpendMinor: r.min_spend_minor, premium: r.is_premium,
  internalNotes: r.internal_notes, status: r.status, version: r.version,
});

/** Live statuses that make a reservation "future" for archive protection and the live floor. */
const LIVE_RESERVATION = `(r.status in ('confirmed', 'seated', 'pending_deposit') or (r.status = 'held' and r.hold_expires_at > now()))`;

@Injectable()
export class FloorService {
  constructor(
    private readonly db: DbService,
    private readonly audit: AuditService,
    private readonly idempotency: IdempotencyService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async get(ctx: TenantContext, branchId: string): Promise<FloorLayout> {
    ctx.assertBranch(branchId);
    return this.db.scoped(ctx, (tx) => this.load(tx, ctx.orgId, branchId));
  }

  private async layoutRow(tx: Tx, orgId: string, branchId: string, lock = false) {
    const branch = await tx.maybeOne('select id from branches where id = $1 and org_id = $2', [branchId, orgId]);
    if (!branch) throw notFound('Branch');
    let row = await tx.maybeOne<any>(`select * from floor_layouts where branch_id = $1${lock ? ' for update' : ''}`, [branchId]);
    if (!row) row = await tx.one(`insert into floor_layouts(org_id, branch_id) values ($1, $2) returning *`, [orgId, branchId]);
    return row;
  }

  private async load(tx: Tx, orgId: string, branchId: string): Promise<FloorLayout> {
    const f = await this.layoutRow(tx, orgId, branchId);
    const tables = await tx.query('select * from dining_tables where branch_id = $1 and is_active order by label', [branchId]);
    return {
      branchId, revision: f.revision, schemaVersion: 2, width: f.width, height: f.height,
      background: { image: null, opacity: 0.45, locked: true, x: 0, y: 0, width: f.width, height: f.height, ...f.background },
      zones: f.zones, objects: f.objects, tables: tables.map(toFloorTable),
    };
  }

  async save(ctx: TenantContext, branchId: string, body: FloorSaveInput): Promise<FloorLayout> {
    ctx.assertBranch(branchId);
    const { key, ...payload } = body;
    return this.db.scoped(ctx, (tx) => this.idempotency.run(tx, ctx.orgId, `floor-save:${branchId}`, key, payload, async () => {
      const f = await this.layoutRow(tx, ctx.orgId, branchId, true);
      if (body.baseRevision !== f.revision) {
        throw new DomainError('stale_layout', 'Another manager saved this floor. Your draft is preserved; reload the saved floor or export your draft.', 409,
          { currentRevision: f.revision });
      }
      const current = await tx.query<CurrentTable & { status: string }>('select * from dining_tables where branch_id = $1 for update', [branchId]);
      const plan = planFloorSave(body.layout, current);
      const kept = new Set(plan.filter((p) => p.current).map((p) => p.current!.id));
      const removed = current.filter((t) => t.is_active && !kept.has(t.id));
      for (const t of removed) {
        const busy = await tx.maybeOne(
          `select 1 from visits where table_id = $1 and status = 'open'
           union all
           select 1 from reservations r where r.table_id = $1 and r.blocked_until > now() and ${LIVE_RESERVATION} limit 1`, [t.id]);
        if (busy) throw new DomainError('table_in_use', `${t.label} has an active visit or future reservation and cannot be removed.`, 409, { tableId: t.id });
      }
      if (removed.length) {
        await tx.query(`update dining_tables set is_active = false, archived_at = now(), version = version + 1 where id = any($1::uuid[])`, [removed.map((t) => t.id)]);
      }
      // Free labels first so swaps (T1 ↔ T2) never trip the unique active-label index.
      const relabel = plan.filter((p) => p.current && p.current.label.toLowerCase() !== p.values.label.toLowerCase());
      for (const p of relabel) await tx.query(`update dining_tables set label = $2 where id = $1`, [p.current!.id, `~${p.current!.id.slice(0, 18)}`]);
      const created: Array<{ clientId: string | null; id: string }> = [];
      for (const p of plan) {
        const v = p.values;
        const params = [v.label, v.capacity, v.zone, v.shape, v.cx, v.cy, v.width, v.height, v.rotation, v.features, v.reservable, v.minSpendMinor, v.premium, v.internalNotes];
        if (p.current) {
          await tx.query(
            `update dining_tables set label = $2, capacity = $3, zone = $4, shape = $5, cx = $6, cy = $7, width = $8, height = $9, rotation = $10,
                features = $11, is_reservable = $12, min_spend_minor = $13, is_premium = $14, internal_notes = $15,
                version = version + case when (label, capacity, zone, shape, cx, cy, width, height, rotation, features, is_reservable,
                    coalesce(min_spend_minor, -1), is_premium, coalesce(internal_notes, '')) is distinct from
                    ($2, $3, $4, $5, $6::numeric, $7::numeric, $8::numeric, $9::numeric, $10::numeric, $11::text[], $12, coalesce($13::bigint, -1), $14, coalesce($15, ''))
                  then 1 else 0 end
              where id = $1`, [p.current.id, ...params]);
        } else {
          const row = await tx.one<{ id: string }>(
            `insert into dining_tables(org_id, branch_id, qr_token, label, capacity, zone, shape, cx, cy, width, height, rotation, features,
                is_reservable, min_spend_minor, is_premium, internal_notes)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) returning id`,
            [ctx.orgId, branchId, newToken(), ...params]);
          created.push({ clientId: p.clientId, id: row.id });
        }
      }
      const l = body.layout;
      await tx.query(
        `update floor_layouts set revision = revision + 1, schema_version = 2, width = $2, height = $3, background = $4, zones = $5, objects = $6,
            updated_by = $7, updated_at = now() where branch_id = $1`,
        [branchId, l.width, l.height, JSON.stringify(l.background), JSON.stringify(l.zones), JSON.stringify(l.objects), ctx.userId]);
      await this.audit.record(tx, ctx, {
        action: 'floor.saved', entityType: 'floor_layout', entityId: f.id, branchId,
        metadata: { revision: f.revision + 1, created: created.length, archived: removed.map((t) => t.id), tables: plan.length },
      });
      return { ...(await this.load(tx, ctx.orgId, branchId)), created };
    }));
  }

  async live(ctx: TenantContext, branchId: string): Promise<LiveFloor> {
    ctx.assertBranch(branchId);
    return this.db.scoped(ctx, async (tx) => {
      const f = await this.layoutRow(tx, ctx.orgId, branchId);
      const tables = await tx.query('select * from dining_tables where branch_id = $1 and is_active order by label', [branchId]);
      const visits = await tx.query<any>(
        `select v.id, v.table_id, v.party_size, v.opened_at, v.opened_via, (v.credit_minor - v.credit_used_minor)::bigint as credit,
                count(o.id) filter (where o.status <> 'cancelled')::int as order_count,
                count(o.id) filter (where o.status in ('placed', 'accepted', 'preparing'))::int as preparing,
                count(o.id) filter (where o.status = 'ready')::int as ready,
                exists (select 1 from payments p where p.visit_id = v.id and p.status in ('pending', 'requires_action', 'authorized'))
                  or exists (select 1 from bill_splits b where b.visit_id = v.id and b.status = 'open') as locked,
                (v.opened_via = 'qr' and v.opened_at > now() - make_interval(secs => $2)
                  and not exists (select 1 from orders x where x.visit_id = v.id) and not exists (select 1 from payments x where x.visit_id = v.id)) as undoable,
                coalesce(sum(o.total_minor) filter (where o.status <> 'cancelled'), 0)::bigint as total,
                coalesce(sum(o.paid_minor - o.refunded_minor) filter (where o.status <> 'cancelled'), 0)::bigint as paid,
                coalesce((select array_agg(distinct s.kind) from service_requests s where s.visit_id = v.id and s.status <> 'resolved'), '{}') as requests
           from visits v left join orders o on o.visit_id = v.id
          where v.branch_id = $1 and v.status = 'open' group by v.id`, [branchId, VISIT_RULES.autoOpenUndoMs / 1000]);
      const reservations = await tx.query<any>(
        `select distinct on (r.table_id) r.id, r.table_id, r.starts_at, r.guest_name, r.party_size from reservations r
          where r.branch_id = $1 and r.table_id is not null and r.ends_at > now()
            and (r.status in ('confirmed', 'pending_deposit') or (r.status = 'held' and r.hold_expires_at > now()))
          order by r.table_id, r.starts_at`, [branchId]);
      return {
        revision: f.revision,
        tables: tables.map((t) => {
          const v = visits.find((x) => x.table_id === t.id);
          const r = reservations.find((x) => x.table_id === t.id);
          return {
            ...toFloorTable(t),
            visit: v ? {
              id: v.id, partySize: v.party_size, openedAt: v.opened_at.toISOString(), orderCount: v.order_count,
              dueMinor: Math.max(0, v.total - v.paid - v.credit), paidMinor: v.paid, requests: v.requests,
              preparing: v.preparing, ready: v.ready, totalMinor: Number(v.total), openedVia: v.opened_via, undoable: v.undoable,
              billingLocked: v.locked,
            } : null,
            nextReservation: r ? { id: r.id, startsAt: r.starts_at.toISOString(), guestName: r.guest_name, partySize: r.party_size } : null,
          };
        }),
      };
    });
  }

  /** Print sheet: the only place table QR URLs (and therefore QR tokens) are returned. */
  async qrSheet(ctx: TenantContext, branchId: string): Promise<{ items: QrSheetItem[] }> {
    ctx.assertBranch(branchId);
    const tables = await this.db.scoped(ctx, async (tx) => {
      await this.layoutRow(tx, ctx.orgId, branchId);
      const rows = await tx.query<{ id: string; label: string; qr_token: string }>(
        'select id, label, qr_token from dining_tables where branch_id = $1 and is_active order by label', [branchId]);
      await this.audit.record(tx, ctx, { action: 'floor.qr_sheet_viewed', entityType: 'branch', entityId: branchId, branchId, metadata: { tables: rows.length } });
      return rows;
    });
    const origin = this.env.APP_ORIGIN.replace(/\/$/, '');
    const items: QrSheetItem[] = [];
    for (const t of tables) {
      const url = `${origin}/t/${t.qr_token}`;
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      items.push({ tableId: t.id, label: t.label, url, svg });
    }
    return { items };
  }

  /**
   * One table's QR for the floor side panel (VS-11: legacy "Table QR code" with Open guest view / Download QR).
   * Same rule as the print sheet: only for floor:write, and every view is audited.
   */
  async tableQr(ctx: TenantContext, branchId: string, tableId: string): Promise<QrSheetItem> {
    ctx.assertBranch(branchId);
    const t = await this.db.scoped(ctx, async (tx) => {
      const row = await tx.maybeOne<{ id: string; label: string; qr_token: string }>(
        'select id, label, qr_token from dining_tables where id = $1 and branch_id = $2 and is_active', [tableId, branchId]);
      if (!row) throw notFound('Table');
      await this.audit.record(tx, ctx, { action: 'floor.table_qr_viewed', entityType: 'dining_table', entityId: row.id, branchId });
      return row;
    });
    const url = `${this.env.APP_ORIGIN.replace(/\/$/, '')}/t/${t.qr_token}`;
    return { tableId: t.id, label: t.label, url, svg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  }

  /** Sanitized geometry for reservation maps: no QR tokens, internal notes or live status. */
  async publicFloor(slug: string, branchCode: string): Promise<PublicFloor> {
    const org = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string }>(`select id from organizations where slug = $1 and status <> 'closed'`, [slug]));
    if (!org) throw notFound('Restaurant');
    return this.db.withTenant(org.id, async (tx) => {
      const branch = await tx.maybeOne<{ id: string; code: string }>('select id, code from branches where org_id = $1 and code = $2 and is_active', [org.id, branchCode]);
      if (!branch) throw notFound('Branch');
      const f = await this.layoutRow(tx, org.id, branch.id);
      const tables = await tx.query('select * from dining_tables where branch_id = $1 and is_active order by label', [branch.id]);
      return {
        branchId: branch.id, branchCode: branch.code, revision: f.revision, width: f.width, height: f.height,
        background: { image: null, opacity: 0.45, locked: true, x: 0, y: 0, width: f.width, height: f.height, ...f.background },
        zones: (f.zones as any[]).filter((z) => !z.hidden), objects: (f.objects as any[]).filter((o) => !o.hidden),
        tables: tables.map((t) => ({
          id: t.id, label: t.label, capacity: t.capacity, zone: t.zone, shape: t.shape, cx: n(t.cx), cy: n(t.cy), width: n(t.width),
          height: n(t.height), rotation: n(t.rotation), features: t.features, reservable: t.is_reservable, minSpendMinor: t.min_spend_minor,
          premium: t.is_premium,
        })),
      };
    }, 'guest:public-floor');
  }
}
