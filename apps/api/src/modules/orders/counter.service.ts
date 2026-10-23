import { Inject, Injectable } from '@nestjs/common';
import type { CounterSession, PublicCounterView, VenueQr } from '@resuto/contracts';
import QRCode from 'qrcode';
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '../../common/auth/context';
import { sha256 } from '../../common/crypto/hash';
import { DbService, type Tx } from '../../common/db/db.service';
import { DomainError, conflict, notFound } from '../../common/errors/domain-error';
import { AuditService } from '../../common/platform/audit.service';
import { OutboxService } from '../../common/platform/outbox.service';
import { StorageService } from '../../common/storage/storage.service';
import { ENV, type Env } from '../../config/env';
import { guestCoverPath, signGuestCover } from './guest-cover';
import { VisitsService } from './visits.service';

/** Same shape as table QR tokens (the legacy app printed both as <origin>/t/<token>). */
export const VENUE_TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * A branch never has more empty counter visits open than this (a scan that orders nothing is swept after
 * COUNTER_ABANDON_MS). It caps what scripted scanning from many addresses can pile up; real counters stay far below.
 */
export const COUNTER_EMPTY_OPEN_CAP = 500;

export interface ResolvedVenue { orgId: string; branchId: string; source: 'venue' | 'legacy' }

/**
 * The legacy counter session (FT-07, legacy server.js /api/table-session with the venue QR): one QR per branch at the
 * till; every scan opens that guest's own table-less visit ("Counter order"). The visit is an ordinary visit of kind
 * `counter`, so ordering, the bill, payments, ratings and the KDS use the table paths unchanged; it carries the same
 * per-visit X-Visit-Token (only its hash is stored, and it stops working when the visit closes).
 *
 * The venue credential: token = HMAC(guest-token key, branch id + nonce); only sha256(token) and the nonce are stored
 * (branches.venue_qr_*), so staff can print the same code again and rotating draws a new nonce. Codes printed by the
 * legacy app (legacy_id_map, entity venue_qr) open the same counter session when their branch serves at a counter.
 */
@Injectable()
export class CounterService {
  constructor(
    private readonly db: DbService,
    private readonly visits: VisitsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly storage: StorageService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private origin() { return this.env.APP_ORIGIN.replace(/\/$/, ''); }

  // ---------------------------------------------------------------------------
  // Staff: the venue QR card and rotation
  // ---------------------------------------------------------------------------
  /**
   * The branch's venue QR. A counter branch gets `/v/<token>` (issued on first use); any other branch the public
   * ordering page, which carries no secret.
   */
  async venueQr(ctx: TenantContext, branchId: string): Promise<VenueQr> {
    ctx.assertBranch(branchId);
    const r = await this.db.scoped(ctx, async (tx) => {
      const b = await tx.maybeOne<any>(
        `select b.id, b.code, b.service_mode, b.venue_qr_nonce, b.venue_qr_hash, b.venue_qr_rotated_at, o.slug
           from branches b join organizations o on o.id = b.org_id where b.id = $1 and b.org_id = $2`, [branchId, ctx.orgId]);
      if (!b) throw notFound('Branch');
      if (b.service_mode !== 'counter') {
        return { kind: 'order' as const, url: `${this.origin()}/order/${b.slug}?branch=${encodeURIComponent(b.code)}`, rotatedAt: null };
      }
      const issued = await this.credential(tx, ctx, b);
      return { kind: 'counter' as const, url: `${this.origin()}/v/${issued.token}`, rotatedAt: issued.rotatedAt };
    });
    return { branchId, ...r, svg: await QRCode.toString(r.url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  }

  /** A new venue code for the branch: the printed one stops opening counter orders at once (open visits continue). */
  async rotateVenueQr(ctx: TenantContext, branchId: string): Promise<VenueQr> {
    ctx.assertBranch(branchId);
    await this.db.scoped(ctx, async (tx) => {
      const b = await tx.maybeOne<any>('select id, service_mode from branches where id = $1 and org_id = $2 for no key update', [branchId, ctx.orgId]);
      if (!b) throw notFound('Branch');
      if (b.service_mode !== 'counter') throw conflict('not_counter', 'Only a counter branch has a venue code to rotate.');
      await this.issue(tx, branchId);
      await this.audit.record(tx, ctx, { action: 'floor.venue_qr_rotated', entityType: 'branch', entityId: branchId, branchId });
    });
    return this.venueQr(ctx, branchId);
  }

  /** The token for a counter branch's stored credential, issuing one when there is none (or its key was retired). */
  private async credential(tx: Tx, ctx: TenantContext, b: { id: string; venue_qr_nonce: string | null; venue_qr_hash: string | null; venue_qr_rotated_at: Date | null }) {
    if (b.venue_qr_nonce) {
      const token = this.visits.tokens.venueToken(b.id, b.venue_qr_nonce, b.venue_qr_hash);
      if (token) return { token, rotatedAt: b.venue_qr_rotated_at ? new Date(b.venue_qr_rotated_at).toISOString() : null };
    }
    // First print (or the key that made the old code was retired): issue under the active key. Concurrent first
    // prints agree on one nonce: only a row still without one is updated, then the stored value is read back.
    await tx.query('select id from branches where id = $1 for no key update', [b.id]);
    const fresh = await tx.one<any>('select venue_qr_nonce, venue_qr_hash, venue_qr_rotated_at from branches where id = $1', [b.id]);
    const again = fresh.venue_qr_nonce ? this.visits.tokens.venueToken(b.id, fresh.venue_qr_nonce, fresh.venue_qr_hash) : null;
    if (again) return { token: again, rotatedAt: fresh.venue_qr_rotated_at ? new Date(fresh.venue_qr_rotated_at).toISOString() : null };
    const issued = await this.issue(tx, b.id);
    await this.audit.record(tx, ctx, { action: 'floor.venue_qr_issued', entityType: 'branch', entityId: b.id, branchId: b.id });
    return issued;
  }

  private async issue(tx: Tx, branchId: string) {
    const nonce = randomUUID();
    const token = this.visits.tokens.venueToken(branchId, nonce);
    const row = await tx.one<{ venue_qr_rotated_at: Date }>(
      `update branches set venue_qr_nonce = $2, venue_qr_hash = $3, venue_qr_rotated_at = now() where id = $1 returning venue_qr_rotated_at`,
      [branchId, nonce, sha256(token)]);
    return { token, rotatedAt: new Date(row.venue_qr_rotated_at).toISOString() };
  }

  // ---------------------------------------------------------------------------
  // Public: resolving a scanned venue code
  // ---------------------------------------------------------------------------
  /**
   * The branch behind a venue code: the branch's current code (by hash), or a code the legacy app printed (the
   * migration's token map). Unknown, ambiguous, or of a closed or suspended restaurant: 404.
   */
  async resolve(token: string): Promise<ResolvedVenue> {
    if (!VENUE_TOKEN.test(token ?? '')) throw notFound('Venue');
    const rows = await this.db.withPlatform((tx) => tx.query<{ org_id: string; branch_id: string; source: 'venue' | 'legacy' }>(
      `select b.org_id, b.id as branch_id, 'venue' as source from branches b
          join organizations o on o.id = b.org_id and o.status not in ('closed', 'suspended')
         where b.venue_qr_hash = $1
       union all
       -- Tenants migrated by an earlier version of the tool map the token to the organization: it resolves to the
       -- organization's main branch (the branch the tool maps it to now) until a re-run moves the row.
       select m.org_id, b.id, 'legacy' from legacy_id_map m
          join organizations o on o.id = m.org_id and o.status not in ('closed', 'suspended')
          join branches b on b.org_id = m.org_id and b.is_active
           and b.id = case when m.new_id = m.org_id
                           then (select x.id from branches x where x.org_id = m.org_id and x.is_active order by (x.code = 'main') desc, x.created_at, x.id limit 1)
                           else m.new_id end
         where m.entity_type = 'venue_qr' and m.legacy_id = $2
       limit 2`, [sha256(token), token]), 'guest:venue-qr');
    if (rows.length !== 1) throw notFound('Venue');
    return { orgId: rows[0]!.org_id, branchId: rows[0]!.branch_id, source: rows[0]!.source };
  }

  /**
   * Where a printed venue code sends the guest: the counter page when the branch serves at a counter, else the
   * branch's public ordering page (an online-only kitchen, or a branch that went back to table service).
   */
  async route(token: string) {
    const v = await this.resolve(token);
    const r = await this.db.withTenant(v.orgId, (tx) => tx.one<{ slug: string; code: string; service_mode: string }>(
      `select o.slug, b.code, b.service_mode from branches b join organizations o on o.id = b.org_id where b.id = $1`, [v.branchId]), 'guest:venue-route');
    return {
      slug: r.slug, branchCode: r.code,
      path: r.service_mode === 'counter' ? `/v/${token}` : `/order/${encodeURIComponent(r.slug)}?branch=${encodeURIComponent(r.code)}`,
    };
  }

  /** Read-only lookup for the counter page (no visit is opened, no token returned). */
  async publicView(token: string): Promise<PublicCounterView> {
    const v = await this.resolve(token);
    const view = await this.db.withTenant(v.orgId, async (tx) => {
      const r = await tx.one<any>(
        `select b.id, b.code, b.name, b.name_ar, b.is_active, b.accepts_pickup, b.service_mode,
                o.name as org_name, o.name_ar as org_name_ar, o.slug, o.currency
           from branches b join organizations o on o.id = b.org_id where b.id = $1`, [v.branchId]);
      return {
        org: { name: r.org_name, nameAr: r.org_name_ar, slug: r.slug, currency: r.currency },
        branch: { id: r.id, code: r.code, name: r.name, nameAr: r.name_ar },
        ...this.availability(r),
        coverPath: await guestCoverPath(tx, v.orgId),
      };
    }, 'guest:venue-lookup');
    const { coverPath, ...rest } = view;
    return { ...rest, cover: await signGuestCover(this.storage, coverPath) };
  }

  private availability(b: { service_mode: string; is_active: boolean; accepts_pickup: boolean }) {
    const reason = b.service_mode !== 'counter' ? 'not_counter' : !b.is_active || !b.accepts_pickup ? 'branch_closed' : null;
    return { accepting: reason === null, reason };
  }

  /**
   * Scan in at the counter (public). A phone that still holds an open counter visit of this branch (X-Visit-Token)
   * rejoins it; otherwise a new counter visit is opened for this guest alone (legacy: every scan starts that guest's
   * own order). Nothing is charged or marked paid here.
   */
  async session(token: string, visitToken: string | undefined): Promise<CounterSession> {
    const venue = await this.resolve(token);
    return this.db.withTenant(venue.orgId, async (tx) => {
      const b = await tx.one<any>(
        `select b.id, b.code, b.name, b.name_ar, b.is_active, b.accepts_pickup, b.service_mode,
                o.name as org_name, o.name_ar as org_name_ar, o.slug, o.currency
           from branches b join organizations o on o.id = b.org_id where b.id = $1 for no key update of b`, [venue.branchId]);
      const out = (visitId: string, token: string, opened: boolean): CounterSession => ({
        kind: 'counter', token, visitId, orgId: venue.orgId, branchId: b.id, currency: b.currency,
        org: { name: b.org_name, nameAr: b.org_name_ar, slug: b.slug }, branch: { code: b.code, name: b.name, nameAr: b.name_ar }, opened,
      });
      if (visitToken && visitToken.length >= 20 && visitToken.length <= 200) {
        const mine = await tx.maybeOne<{ id: string; guest_token_hash: string }>(
          `select id, guest_token_hash from visits where guest_token_hash = $1 and status = 'open' and kind = 'counter' and branch_id = $2`,
          [sha256(visitToken), b.id]);
        if (mine) return out(mine.id, visitToken, false);
      }
      const { reason } = this.availability(b);
      if (reason === 'not_counter') throw conflict('venue_unavailable', 'This restaurant takes orders on its website.', { reason });
      if (reason) throw conflict('venue_unavailable', 'This counter is not taking orders right now.', { reason });
      const empty = await tx.one<{ n: number }>(
        `select count(*)::int as n from visits v where v.branch_id = $1 and v.kind = 'counter' and v.status = 'open'
            and not exists (select 1 from orders o where o.visit_id = v.id)`, [b.id]);
      if (empty.n >= COUNTER_EMPTY_OPEN_CAP) {
        throw new DomainError('rate_limited', 'The counter is very busy. Please try again in a minute.', 429, { retryAfterMs: 60_000 });
      }
      const id = randomUUID();
      await tx.query(
        `insert into visits(id, org_id, branch_id, table_id, kind, guest_token_hash, opened_via) values ($1, $2, $3, null, 'counter', $4, 'qr')`,
        [id, venue.orgId, b.id, this.visits.tokens.hashFor(id)]);
      await this.outbox.publish(tx, venue.orgId, { type: 'visit.opened', aggregateType: 'visit', aggregateId: id, payload: { tableId: null, kind: 'counter', branchId: b.id, via: 'qr' } });
      return out(id, this.visits.tokens.tokenFor(id), true);
    }, `guest:venue:${venue.branchId}`);
  }
}
