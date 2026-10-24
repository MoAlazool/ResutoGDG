import { Injectable } from '@nestjs/common';
import {
  POS_CONTRACT_VERSION, POS_DEVICE_TOKEN_PREFIX, POS_PAIRING_CODE_ALPHABET, POS_PAIRING_CODE_LENGTH, ROLE_PERMISSIONS,
  type CreatePosPairingRequest, type Page, type PosDevicePaired, type PosDeviceSummary, type PosPairingCreated, type PosPairRequest, type PosSession,
} from '@resuto/contracts';
import { randomBytes, randomInt } from 'node:crypto';
import { z } from 'zod';
import type { posDeviceListQuery } from '@resuto/contracts';
import { TenantContext } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { DbService } from '../../common/db/db.service';
import { DomainError, conflict, notFound } from '../../common/errors/domain-error';
import { branchScope, cursorAt, keyset, pageOf } from '../../common/http/pagination';
import { AuditService } from '../../common/platform/audit.service';
import { deviceBranch, PosFeedService } from './pos-feed.service';

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

// Never select token_hash or code_hash: sessions cannot read them (column grants) and they never leave the database.
const DEVICE_COLUMNS = `d.id, d.branch_id, d.name, d.acting_role, d.token_prefix, d.status, d.platform, d.app_version, d.model, d.paired_at,
  d.expires_at, d.last_seen_at, d.revoked_at, d.revoke_reason`;

export const toDevice = (r: any): PosDeviceSummary => ({
  id: r.id, branchId: r.branch_id, name: r.name, actingRole: r.acting_role, tokenPrefix: r.token_prefix, status: r.status,
  expired: !!r.expires_at && new Date(r.expires_at) <= new Date(), platform: r.platform, appVersion: r.app_version, model: r.model,
  pairedAt: iso(r.paired_at)!, expiresAt: iso(r.expires_at), lastSeenAt: iso(r.last_seen_at), revokedAt: iso(r.revoked_at), revokeReason: r.revoke_reason,
});

/** `rpos_<43 url-safe chars>` (256 bits). Only its sha256 and a display prefix are stored. */
export function newDeviceToken() {
  const token = `${POS_DEVICE_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { token, prefix: token.slice(0, POS_DEVICE_TOKEN_PREFIX.length + 8), hash: sha256(token) };
}

/** Ten random characters of the pairing alphabet (50 bits), shown as XXXXX-XXXXX. */
export function newPairingCode() {
  let raw = '';
  for (let i = 0; i < POS_PAIRING_CODE_LENGTH; i++) raw += POS_PAIRING_CODE_ALPHABET[randomInt(POS_PAIRING_CODE_ALPHABET.length)];
  return { display: `${raw.slice(0, 5)}-${raw.slice(5)}`, hash: sha256(raw) };
}

/** What the device typed: case-insensitive, dashes and spaces ignored; null when it cannot be a code. */
export function normalisePairingCode(input: string): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, '');
  if (raw.length !== POS_PAIRING_CODE_LENGTH || [...raw].some((c) => !POS_PAIRING_CODE_ALPHABET.includes(c))) return null;
  return raw;
}

const pairingInvalid = () => new DomainError('pairing_code_invalid', 'This pairing code is not valid. Ask a manager for a new one.', 401);

/**
 * Native POS devices (21-POSAPI): a manager (devices:manage) creates a one-time pairing code for a branch and an
 * acting role; the device exchanges it for its own credential (rpos_..., hashed at rest), which the access guard
 * accepts only on the POS device API. Pairing, pairing codes and revocation are audited.
 */
@Injectable()
export class PosDevicesService {
  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly feed: PosFeedService) {}

  async createPairing(ctx: TenantContext, input: CreatePosPairingRequest): Promise<PosPairingCreated> {
    ctx.assertBranch(input.branchId);
    const code = newPairingCode();
    // Not idempotent on purpose: replaying a stored response would show the code a second time.
    return this.db.scoped(ctx, async (tx) => {
      const branch = await tx.maybeOne<{ is_active: boolean }>('select is_active from branches where id = $1 and org_id = $2', [input.branchId, ctx.orgId]);
      if (!branch) throw notFound('Branch');
      if (!branch.is_active) throw conflict('branch_unavailable', 'This branch is not active.');
      const row = await tx.one<{ id: string; expires_at: Date }>(
        `insert into pos_device_pairings(org_id, branch_id, name, acting_role, code_hash, device_ttl_days, created_by, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(mins => $8)) returning id, expires_at`,
        [ctx.orgId, input.branchId, input.name, input.actingRole, code.hash, input.deviceTtlDays, ctx.userId, input.expiresInMinutes]);
      await this.audit.record(tx, ctx, { action: 'pos.pairing.created', entityType: 'pos_device_pairing', entityId: row.id, branchId: input.branchId,
        metadata: { name: input.name, actingRole: input.actingRole, expiresInMinutes: input.expiresInMinutes, deviceTtlDays: input.deviceTtlDays } });
      return { id: row.id, branchId: input.branchId, actingRole: input.actingRole, name: input.name, code: code.display, expiresAt: iso(row.expires_at)! };
    });
  }

  /** Public: a pairing code (single use, unexpired, of an open restaurant and an active branch) → the device credential. */
  async pair(input: PosPairRequest): Promise<PosDevicePaired> {
    const raw = normalisePairingCode(input.code);
    if (!raw) throw pairingInvalid();
    const found = await this.db.withPlatform((tx) => tx.maybeOne<{ id: string; org_id: string; branch_id: string }>(
      `select p.id, p.org_id, p.branch_id from pos_device_pairings p
          join organizations o on o.id = p.org_id and o.status not in ('closed', 'suspended')
          join branches b on b.id = p.branch_id and b.is_active
        where p.code_hash = $1 and p.consumed_at is null and p.expires_at > now()`, [sha256(raw)]), 'pos:pair');
    if (!found) throw pairingInvalid();
    const t = newDeviceToken();
    return this.db.withTenant(found.org_id, async (tx) => {
      // Single use under concurrency: only the first transaction consumes the code.
      const p = await tx.maybeOne<any>(
        `update pos_device_pairings set consumed_at = now() where id = $1 and consumed_at is null and expires_at > now()
         returning id, branch_id, name, acting_role, device_ttl_days, created_by`, [found.id]);
      if (!p) throw pairingInvalid();
      const d = await tx.one<any>(
        `insert into pos_devices as d (org_id, branch_id, name, acting_role, token_prefix, token_hash, platform, app_version, model, pairing_id, created_by, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now() + make_interval(days => $12)) returning ${DEVICE_COLUMNS}`,
        [found.org_id, p.branch_id, p.name, p.acting_role, t.prefix, t.hash, input.platform, input.appVersion ?? null, input.model ?? null, p.id,
          p.created_by, p.device_ttl_days]);
      await tx.query('update pos_device_pairings set device_id = $2 where id = $1', [p.id, d.id]);
      const ctx = new TenantContext(found.org_id, d.acting_role, [d.branch_id], null, 'device', d.id, 'api');
      await this.audit.record(tx, ctx, { action: 'pos.device.paired', entityType: 'pos_device', entityId: d.id, branchId: d.branch_id,
        metadata: { pairingId: p.id, name: d.name, actingRole: d.acting_role, tokenPrefix: d.token_prefix, platform: d.platform, appVersion: d.app_version } });
      return { token: t.token, device: toDevice(d), orgId: found.org_id, contractVersion: POS_CONTRACT_VERSION };
    }, 'pos:pair');
  }

  async list(ctx: TenantContext, q: z.infer<typeof posDeviceListQuery>): Promise<Page<PosDeviceSummary>> {
    if (q.branchId) ctx.assertBranch(q.branchId);
    const k = keyset(q.cursor);
    return this.db.scoped(ctx, async (tx) => {
      const rows = await tx.query<any>(
        `select ${DEVICE_COLUMNS}, ${cursorAt('d.paired_at')} as cursor_at from pos_devices d
          where d.org_id = $1 and ${branchScope('d.branch_id', 2)} and ($3::text is null or d.status = $3) and ($4::uuid is null or d.branch_id = $4)
            ${k.after('d.paired_at', 'd.id', 5)}
          order by d.paired_at desc, d.id desc limit ${k.fetch(q.limit)}`,
        [ctx.orgId, ctx.branchFilter, q.status ?? null, q.branchId ?? null, ...k.params]);
      return pageOf(rows, q.limit, (r) => ({ at: r.cursor_at, id: r.id }), toDevice);
    });
  }

  async get(ctx: TenantContext, id: string): Promise<PosDeviceSummary> {
    return this.db.scoped(ctx, async (tx) => {
      const r = await tx.maybeOne<any>(`select ${DEVICE_COLUMNS} from pos_devices d where d.org_id = $1 and d.id = $2`, [ctx.orgId, id]);
      if (!r || !ctx.canAccessBranch(r.branch_id)) throw notFound('Device');
      return toDevice(r);
    });
  }

  /** Immediate: the guard refuses the credential from the next request on (device_revoked). */
  async revoke(ctx: TenantContext, id: string, reason: string | null | undefined): Promise<PosDeviceSummary> {
    return this.db.scoped(ctx, async (tx) => {
      const current = await tx.maybeOne<any>(`select ${DEVICE_COLUMNS} from pos_devices d where d.org_id = $1 and d.id = $2 for update`, [ctx.orgId, id]);
      if (!current || !ctx.canAccessBranch(current.branch_id)) throw notFound('Device');
      if (current.status === 'revoked') return toDevice(current);
      const row = await tx.one<any>(
        `update pos_devices d set status = 'revoked', revoked_at = now(), revoked_by = $3, revoke_reason = $4 where d.org_id = $1 and d.id = $2
         returning ${DEVICE_COLUMNS}`, [ctx.orgId, id, ctx.userId, reason?.trim() || null]);
      await this.audit.record(tx, ctx, { action: 'pos.device.revoked', entityType: 'pos_device', entityId: id, branchId: row.branch_id,
        metadata: { tokenPrefix: row.token_prefix, reason: row.revoke_reason } });
      return toDevice(row);
    });
  }

  /** The device's own view: who it is, where, what it may do, and where the feed stands. */
  async session(ctx: TenantContext): Promise<PosSession> {
    const branchId = deviceBranch(ctx);
    return this.db.scoped(ctx, async (tx) => {
      const d = await tx.one<any>(`select ${DEVICE_COLUMNS} from pos_devices d where d.id = $1`, [ctx.actorId]);
      const o = await tx.one<any>('select id, name, name_ar, currency, country, timezone from organizations where id = $1', [ctx.orgId]);
      const b = await tx.one<any>(
        `select id, code, name, name_ar, coalesce(timezone, $2) as timezone, service_mode, accepts_dine_in, accepts_pickup, accepts_delivery
           from branches where id = $1`, [branchId, o.timezone]);
      return {
        device: toDevice(d),
        org: { id: o.id, name: o.name, nameAr: o.name_ar, currency: o.currency, country: o.country, timezone: o.timezone },
        branch: { id: b.id, code: b.code, name: b.name, nameAr: b.name_ar, timezone: b.timezone, serviceMode: b.service_mode,
          acceptsDineIn: b.accepts_dine_in, acceptsPickup: b.accepts_pickup, acceptsDelivery: b.accepts_delivery },
        permissions: [...ROLE_PERMISSIONS[ctx.role]],
        feed: await this.feed.position(tx, branchId),
        serverTime: new Date().toISOString(),
        contractVersion: POS_CONTRACT_VERSION,
      };
    });
  }
}
